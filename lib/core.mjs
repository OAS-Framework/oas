/**
 * lib/core.mjs — runtime-neutral OAS library (souls & instances, config cascade,
 * capabilities, lifecycle hooks). No pi imports: consumed by both the standalone
 * `oas` CLI (bin/oas.mjs) and the pi extension adapter (extension/index.ts).
 *
 * An "agents root" is the CLOSEST directory named `agents/` found by walking up
 * from cwd (or $PI_AGENTS_ROOT); a scope with only `local-agents/` resolves to
 * its (possibly absent) sibling `agents/` as the canonical root — OAS is fully
 * usable with local agents alone. The root's parent is the "workspace" (scope);
 * soul `repo` paths resolve relative to it.
 *
 * Layout:
 *   <scope>/agents/<agent>/soul/       canonical body: soul.yaml, AGENTS.md (canonical; CLAUDE.md → AGENTS.md),
 *                                      skills/, knowledge/ (OKF bundle)
 *   <scope>/agents/<agent>/instances/<inst>/  instance HOME: generated AGENTS.md, CLAUDE.md → AGENTS.md,
 *                                      soul → soul dir, .agents/skills (canonical; .claude/skills → ../.agents/skills),
 *                                      work/ (worktree or symlink), TASK.md, STATE.md, log.md, notes/, instance.json
 *   <scope>/local-agents/<name>/       LOCAL souls — same soul/ + instances/ shape and full memory,
 *                                      but uncommitted by contract: the dir is created on first use and
 *                                      auto-gitignored when the scope is a git repo. Legacy nested
 *                                      <root>/local-agents/ and <root>/tmp-agents/ are still read.
 *
 * soul.yaml (flat key: value):
 *   name, description, kind (persistent|local), type (optional agent-type/family, targeted by config),
 *   repo (path rel. to workspace or absolute),
 *   work (worktree|checkout|attached), runtime (pi|claude), model (pi model pattern, optional)
 *   (attached as soul default is for service agents — spawn must supply workDir)
 */
import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const RESERVED = new Set(["bin", "local-agents", "tmp-agents"]);
/** The work modes spawn accepts — also the enum a quarantine cleanup descriptor
 * must satisfy, so the retry cannot skip Git cleanup on an unrecognised value. */
export const WORK_MODES = ["worktree", "checkout", "attached", "workspace"];
/** Local (uncommitted) souls dir: <scope>/local-agents, a SIBLING of agents/.
 * Legacy nested <root>/local-agents and <root>/tmp-agents are still read. */
export const LOCAL_AGENTS_DIR = "local-agents";
const LEGACY_LOCAL_DIRS = ["local-agents", "tmp-agents"]; // nested-in-root legacy locations
/** The scope-level local agents dir for an agents root (the root's sibling). */
export const localAgentsDirOf = (root) => join(dirname(root), LOCAL_AGENTS_DIR);
export const DEFAULT_TMUX_SESSION = process.env.PI_AGENTS_TMUX_SESSION || "pi-agents";
/** Package root (this file lives in <pkg>/lib/). */
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OAS_VERSION = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
/** Skills shipped with the kernel. Only oas-getting-started is ambient; spawn composes selected skills locally. */
export const PACKAGED_SKILLS_DIR = join(PKG_ROOT, "skills");

// ---------- shell helpers ----------
function sh(cmdline) { return execSync(cmdline, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function shTry(cmdline) { try { return sh(cmdline); } catch { return undefined; } }
function shIn(cwd, cmdline, timeout = 45000) {
  return execSync(cmdline, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
}
function shInTry(cwd, cmdline, timeout) { try { return shIn(cwd, cmdline, timeout); } catch { return undefined; } }
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
export function slug(s) {
  const r = String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return r || "agent";
}
function which(bin) { return shTry(`command -v ${shq(bin)}`); }


// ---------- yaml-ish ----------
export function parseYamlFlat(text) {
  const o = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*(#.*)?$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return o;
}
/** Small dependency-free YAML subset used by oas-config.yaml.
 * Supports nested maps, namespaced/quoted keys, booleans, numbers, and inline arrays/maps. */
function yamlScalar(raw) {
  const val = raw.trim().replace(/\s+#.*$/, "").trim();
  if (/^(true|false)$/i.test(val)) return val.toLowerCase() === "true";
  if (/^(null|~)$/i.test(val)) return null;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  if (val.startsWith("[") && val.endsWith("]")) {
    return val.slice(1, -1).split(",").map((v) => yamlScalar(v)).filter((v) => v !== "");
  }
  if (val.startsWith("{") && val.endsWith("}")) {
    const out = {};
    for (const part of val.slice(1, -1).split(",")) {
      const i = part.indexOf(":");
      if (i < 0) continue;
      const key = part.slice(0, i).trim().replace(/^["']|["']$/g, "");
      out[key] = yamlScalar(part.slice(i + 1));
    }
    return out;
  }
  return val.replace(/^["']|["']$/g, "");
}
export function parseYamlNested(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = raw.match(/^(\s*)((?:["'][^"']+["'])|(?:[^:#][^:]*?)):\s*(.*?)\s*$/);
    if (!m) continue;
    const [, ws, rawKey, rawVal] = m;
    const key = rawKey.trim().replace(/^["']|["']$/g, "");
    const indent = ws.length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (rawVal.replace(/\s+#.*$/, "").trim() === "" || rawVal.trim().startsWith("#")) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else parent[key] = yamlScalar(rawVal);
  }
  return root;
}
function yamlFlat(o) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n") + "\n";
}
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  return { meta: parseYamlFlat(m[1]), body: m[2].trim() + "\n" };
}

// ---------- root discovery ----------
/** Closest agents/ dir walking up from `cwd`. Returns undefined if none. */
export function findRoot(cwd = process.cwd()) {
  if (process.env.PI_AGENTS_ROOT) return resolve(process.env.PI_AGENTS_ROOT);
  let d = resolve(cwd);
  while (true) {
    if (basename(d) === "agents" && lstatSync(d).isDirectory()) return d;
    if (basename(d) === LOCAL_AGENTS_DIR && lstatSync(d).isDirectory() && basename(dirname(d)) !== "agents") {
      return join(dirname(d), "agents"); // sibling layout: canonical root beside local-agents (may not exist yet)
    }
    const candidate = join(d, "agents");
    if (existsSync(candidate) && lstatSync(candidate).isDirectory()) return candidate;
    // A scope with only local agents is fully operable: its canonical agents
    // root is the (possibly absent) sibling agents/ dir.
    if (existsSync(join(d, LOCAL_AGENTS_DIR)) && lstatSync(join(d, LOCAL_AGENTS_DIR)).isDirectory()) return candidate;
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}
/** realpath of `p`, or — when `p` does not exist yet — the realpath of its
 * nearest existing ancestor with the remaining segments re-appended. Any path
 * decision about WHERE something will be created has to go through this: a
 * lexical path says nothing about the destination once a symlink sits anywhere
 * along it. */
function realPathOrNearest(p) {
  try { return realpathSync(p); } catch { /* not created yet — resolve what exists */ }
  let d = resolve(p); const tail = [];
  while (!existsSync(d) && dirname(d) !== d) { tail.unshift(basename(d)); d = dirname(d); }
  try { return join(realpathSync(d), ...tail); } catch { return resolve(p); }
}

/** Is there a Git marker (`.git` dir or worktree pointer file) at or above `dir`?
 * Filesystem-only: it answers "does Git own this location" even when the git
 * binary is missing, refuses the repo (dubious ownership), or cannot read its
 * metadata — cases where a probe failure must NOT be read as "not a repo". */
function hasGitMarker(dir) {
  let d = resolve(dir);
  while (true) {
    if (existsSync(join(d, ".git"))) return true;
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

/** Canonicalize any deployment path that determines where an instance HOME is
 * created — the agents root, and the agent directory derived from it.
 *
 * findRoot() walks up from the INVOCATION directory, so the path can sit inside
 * a LINKED git worktree: a human running `oas spawn` from a worktree, or (far
 * more common) an agent that ran `cd ./work` first. Instance homes must live in
 * the soul-owning repo's PRIMARY checkout — `agents/*​/instances/` is gitignored,
 * so a home created in a linked worktree is invisible in status, and it dies
 * with the tree that hosted it.
 *
 * Canonical identity comes from Git, never from a branch name: the FIRST record
 * of `git worktree list --porcelain` is the main worktree. Probes are argv-based
 * (paths may contain shell metacharacters) and read-only.
 *
 * Returns the path unchanged only when Git does not own the location, when it is
 * already in the main worktree, or when it lies outside the work tree it was
 * discovered from. Throws E_NO_CANONICAL_ROOT whenever Git DOES own the location
 * but the primary checkout cannot be established — including a failed probe,
 * which must never pass as "not a repo" (reviewer-2366d09): guessing recreates
 * the very misplacement this exists to prevent.
 */
export function canonicalDeploymentPath(p) {
  if (!p) return p;
  const abs = resolve(p);
  const probe = (argv) => {
    try { return { ok: true, out: execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) { return { ok: false, err: String(e.stderr || e.message || "").trim() }; }
  };
  // The scope that owns the path. The directory itself may not exist yet
  // (local-only scopes, an agent dir created on first use), so probe from the
  // nearest existing ancestor.
  let scope = dirname(abs);
  while (!existsSync(scope) && dirname(scope) !== scope) scope = dirname(scope);
  const top = probe(["git", "-C", scope, "rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    // A failed probe is NOT evidence of a non-Git scope. Only the absence of any
    // Git marker is — otherwise an unavailable/erroring git would silently let a
    // linked worktree through, which is exactly the fail-open this prevents.
    if (hasGitMarker(scope)) {
      throw oasError("E_NO_CANONICAL_ROOT", `${abs} is inside a Git-owned location whose repository could not be read (${top.err || "git rev-parse failed"}) — instance homes must live in the soul-owning repo's primary checkout, and OAS cannot confirm this is it; fix the Git error or pass --dir <primary checkout>`);
    }
    return abs;                                  // genuinely not a Git work tree
  }
  const toplevel = top.out.trim();
  if (!toplevel) return abs;
  // Git reports CANONICAL paths, so every comparison and every relative()
  // below must be realpath-based: on macOS a temp/agents root reached through
  // /var while Git reports /private/var would otherwise look "outside" the
  // work tree and silently skip canonicalization. The agents dir itself may
  // not exist yet (local-only scopes), so resolve the nearest existing
  // ancestor and re-append the remainder.
  const realOf = realPathOrNearest;
  const same = (a, b) => realOf(a) === realOf(b);
  // Linked or main? `--git-dir` equals `--git-common-dir` in the MAIN worktree
  // and points at <common>/worktrees/<name> in a linked one. This settles it
  // without `git worktree list`, so the overwhelmingly common main-checkout
  // path costs one probe and — crucially — cannot be failed by a hiccup in a
  // command it does not need (a forced `worktree list` failure used to reject
  // an ordinary main-checkout spawn).
  const dirs = probe(["git", "-C", scope, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  const [gitDir, commonDir] = dirs.ok
    ? dirs.out.trim().split("\n").map((l) => l.trim())
    // Pre-2.31 git has no --path-format: fall back to plain output, whose paths
    // may be relative to the scope.
    : (() => {
      const plain = probe(["git", "-C", scope, "rev-parse", "--git-dir", "--git-common-dir"]);
      if (!plain.ok) return [];
      return plain.out.trim().split("\n").map((l) => resolve(scope, l.trim()));
    })();
  if (!gitDir || !commonDir) {
    throw oasError("E_NO_CANONICAL_ROOT", `${abs} is inside the Git work tree ${toplevel}, but OAS could not tell a linked worktree from the primary checkout (${dirs.err || "git rev-parse --git-dir/--git-common-dir failed"}) — instance homes must live in the soul-owning repo's primary checkout; fix the Git error or pass --dir <primary checkout>`);
  }
  // Main checkout: the common case, and the one that must stay free — returned
  // untouched, in the caller's own path form.
  if (same(gitDir, commonDir)) return abs;
  // Linked worktree from here on — the primary checkout is REQUIRED, not optional.
  const list = probe(["git", "-C", scope, "worktree", "list", "--porcelain", "-z"]);
  const mainWorktree = list.ok
    ? (list.out.split("\0").find((f) => f.startsWith("worktree ")) || "").slice("worktree ".length)
    : undefined;
  if (!list.ok) throw oasError("E_NO_CANONICAL_ROOT", `${abs} is inside the linked Git worktree ${toplevel}, and the primary checkout could not be determined (${list.err || "git worktree list failed"}) — instance homes must live in the soul-owning repo's primary checkout; re-run from it or pass --dir <primary checkout>`);
  if (!mainWorktree) throw oasError("E_NO_CANONICAL_ROOT", `${abs} is inside the linked Git worktree ${toplevel}, but \`git worktree list\` reported no main worktree — instance homes must live in the soul-owning repo's primary checkout; re-run from it or pass --dir <primary checkout>`);
  if (!existsSync(mainWorktree)) throw oasError("E_NO_CANONICAL_ROOT", `${abs} is inside the linked Git worktree ${toplevel}, whose primary checkout ${mainWorktree} does not exist — instance homes must live in the soul-owning repo's primary checkout; restore it or pass --dir <primary checkout>`);
  // Map the root's position within the linked tree onto the primary checkout.
  // A root OUTSIDE the work tree (sibling agents/ beside the repo) is not a
  // worktree artifact and is left exactly where it is.
  const rel = relative(realOf(toplevel), realOf(abs));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return abs;
  const canonical = join(realOf(mainWorktree), rel);
  const back = relative(realOf(mainWorktree), canonical);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw oasError("E_NO_CANONICAL_ROOT", `canonical root for ${abs} would escape the primary checkout ${mainWorktree}`);
  }
  return canonical;
}
/** The canonical deployment root — where instance homes belong. */
export function canonicalAgentsRoot(root) { return canonicalDeploymentPath(root); }
export function ensureRoot(cwd) {
  const root = findRoot(cwd);
  if (!root) {
    throw new Error(
      `no agents/ or local-agents/ directory found walking up from ${resolve(cwd ?? process.cwd())} — create one (mkdir agents, or \`oas create <name> --local\`) or set PI_AGENTS_ROOT`,
    );
  }
  // Deployment root ≠ invocation CWD: homes always land in the primary checkout.
  return canonicalAgentsRoot(root);
}
export function workspaceOf(root) { return dirname(root); }

// ---------- oas-config (three-level cascade) ----------
export const LAYERS = ["knowledge", "messaging", "tasks"];

/** Capabilities that shipped historically and were later retired. Configs and
 * locks in the wild may still name them — every load-path failure they cause
 * must point at the migration, never read as an unexplained missing package. */
export const RETIRED_CAPABILITIES = {
  "oas.web": "the oas.web web panel was retired — the OAS Desktop app (packages/desktop in the framework repo) replaced it and bundles the same loopback server. Remove the oas.web entry from oas-config.yaml (capabilities.additive) and from oas-lock.json at this scope",
};
/** Exact retirement membership; prototype names must never inherit a reason. */
export function retiredCapabilityReason(id) {
  return Object.hasOwn(RETIRED_CAPABILITIES, id) ? RETIRED_CAPABILITIES[id] : undefined;
}
const CONFIG_KEYS = new Set(["name", "team", "agent-types", "capabilities", "skill-overrides", "agents-md-injection", "oas", "work-modes", "templates"]);
const RENAMED_CONFIG_KEYS = {
  groups: 'declare "agent-types:" (names + descriptions only); membership moved to `type:` in each soul.yaml',
  layers: 'fundamental layers moved under "capabilities.layers.<layer>" (a capability entry or an explicit "none")',
};
const CAPABILITY_ENTRY_KEYS = new Set(["capability", "from", "global", "agent-types", "souls", "settings", "injection-override"]);
const RENAMED_ENTRY_KEYS = { injection: 'renamed to "injection-override:" (same values: <path>|none|default)' };
const WORK_MODE_KEYS = new Set(["setup"]);

/** Flatten one level's capability declarations: [{ id, spec, slot }] (slot = layer name for layer entries). */
export function configCapabilityEntries(cfg) {
  const out = [];
  const caps = cfg?.capabilities || {};
  for (const [layer, entry] of Object.entries(caps.layers || {})) {
    if (entry === "none" || !entry || typeof entry !== "object") continue;
    out.push({ id: entry.capability, spec: entry, slot: layer });
  }
  for (const [id, entry] of Object.entries(caps.additive || {})) {
    out.push({ id, spec: entry && typeof entry === "object" ? entry : {}, slot: undefined });
  }
  return out;
}

/** Load and validate one level's canonical <dir>/oas-config.yaml. */
function loadLevelConfig(dir) {
  const file = join(dir, "oas-config.yaml");
  if (!existsSync(file)) return undefined;
  const cfg = parseYamlNested(readFileSync(file, "utf8"));
  validateConfigShape(cfg, file);
  cfg._level = dir; cfg._file = file;
  return cfg;
}

/** Validate a parsed oas-config object against the config schema rules.
 * Shared by the level loader and package profile validation (a profile is
 * config source material and must pass the same shape checks). */
export function validateConfigShape(cfg, file) {
  for (const key of Object.keys(cfg)) {
    if (RENAMED_CONFIG_KEYS[key]) throw new Error(`unsupported oas-config key "${key}" in ${file} — ${RENAMED_CONFIG_KEYS[key]}`);
    if (!CONFIG_KEYS.has(key)) throw new Error(`unsupported oas-config key in ${file}: ${key}`);
  }
  const caps = cfg.capabilities || {};
  const strays = Object.keys(caps).filter((k) => k !== "layers" && k !== "additive");
  if (strays.length) throw new Error(`capabilities in ${file} must nest under "layers:" (fundamental slots) or "additive:" — found: ${strays.join(", ")}`);
  const validateEntry = (entry, what) => {
    for (const k of Object.keys(entry)) {
      if (RENAMED_ENTRY_KEYS[k]) throw new Error(`unsupported key "${k}" for ${what} in ${file} — ${RENAMED_ENTRY_KEYS[k]}`);
      if (!CAPABILITY_ENTRY_KEYS.has(k)) throw new Error(`unsupported keys for ${what} in ${file}: ${k}`);
    }
    if (entry["injection-override"] !== undefined && (entry.from === "owned" || String(entry.from || "").startsWith("path:")))
      throw new Error(`injection-override on ${what} in ${file} is not allowed for from: ${entry.from} — you own the package source; edit its injects/ file directly`);
    if (entry.from === "bundled")
      throw new Error(`"from: bundled" on ${what} in ${file} is no longer supported — official capabilities install from the marketplace: change it to "from: installed", then run \`oas install ${entry.capability || what}\` at this scope`);
  };
  for (const [layer, entry] of Object.entries(caps.layers || {})) {
    if (!LAYERS.includes(layer)) throw new Error(`unknown fundamental layer "${layer}" in ${file} (layers: ${LAYERS.join(", ")})`);
    if (entry === "none") continue;
    if (!entry || typeof entry !== "object" || !entry.capability) throw new Error(`capabilities.layers.${layer} in ${file} must be "none" or an entry with "capability: <id>"`);
    validateEntry(entry, `capabilities.layers.${layer}`);
  }
  for (const [id, entry] of Object.entries(caps.additive || {})) {
    validateEntry(entry && typeof entry === "object" ? entry : {}, `capability ${id}`);
  }
  for (const [mode, wm] of Object.entries(cfg["work-modes"] || {})) {
    if (!wm || typeof wm !== "object") continue;
    for (const k of Object.keys(wm)) {
      if (k === "injection" || k === "injection-override") throw new Error(`unsupported key "${k}" for work-modes.${mode} in ${file} — work-mode injection overrides were removed; the packaged briefings are the contract. Work modes support "setup:" (env bootstrap script) only`);
      if (!WORK_MODE_KEYS.has(k)) throw new Error(`unsupported key "${k}" for work-modes.${mode} in ${file} (supported: ${[...WORK_MODE_KEYS].join(", ")})`);
    }
  }
  if (cfg.oas && typeof cfg.oas === "object" && cfg.oas.injection !== undefined) throw new Error(`unsupported key "injection" for oas in ${file} — ${RENAMED_ENTRY_KEYS.injection}`);
  if (cfg.team !== undefined) {
    if (!cfg.team || typeof cfg.team !== "object" || Array.isArray(cfg.team)) throw new Error(`team in ${file} must be a map with "name:" (and optionally "id:")`);
    const unknown = Object.keys(cfg.team).filter((k) => !["name", "id"].includes(k));
    if (unknown.length) throw new Error(`unsupported team key${unknown.length > 1 ? "s" : ""} in ${file}: ${unknown.join(", ")}`);
    if (!cfg.team.name) throw new Error(`team in ${file} needs "name:"`);
  }
}

/** All level configs from startDir upward, closest first. */
export function configChain(startDir) {
  const chain = [];
  let d = resolve(startDir);
  while (true) {
    const cfg = loadLevelConfig(d);
    if (cfg) chain.push(cfg);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return chain;
}

function bindingObject(value) {
  if (value === true) return { enabled: true };
  if (value === false) return { enabled: false };
  return value && typeof value === "object" ? value : undefined;
}
/** A hook declaration is either a command string, or `{ command, required }`.
 * `required: true` means the capability cannot function if the hook fails — an
 * aweb spawn hook that cannot mint an identity leaves an instance believing it
 * has messaging it does not have — so the spawn fails and is rolled back
 * instead of proceeding with a half-configured capability. */
function hookDeclaration(value) {
  if (typeof value === "string") return { command: value, required: false };
  if (value && typeof value === "object" && typeof value.command === "string") {
    return { command: value.command, required: value.required === true };
  }
  return undefined;
}
function manifestHookCommands(manifest) {
  const out = {};
  for (const [ev, value] of Object.entries(manifest?.hooks || {})) {
    const decl = hookDeclaration(value);
    if (!APPROVED_HOOKS.has(ev) || !decl) continue;
    const [script, ...args] = decl.command.split(/\s+/);
    const abs = manifestPath(manifest, script);
    if (abs) out[ev] = ["node", shq(abs), ...args].join(" ");
  }
  return out;
}
/** Events this capability declares as required, i.e. fatal to a spawn if they fail. */
function manifestRequiredHooks(manifest) {
  const out = [];
  for (const [ev, value] of Object.entries(manifest?.hooks || {})) {
    const decl = hookDeclaration(value);
    if (APPROVED_HOOKS.has(ev) && decl?.required) out.push(ev);
  }
  return out;
}
const APPROVED_HOOKS = new Set(["soul-scaffold", "spawn", "retire"]);

/** The declared type (agent family) of a soul, read from its soul.yaml via the agents root. */
export function soulTypeOf(contextDir, soulName) {
  if (!soulName) return undefined;
  try {
    const root = findRoot(contextDir);
    const agent = root && findAgent(root, soulName);
    return agent?.type || undefined;
  } catch { return undefined; }
}

/** Does a manifest's discovery origin satisfy a config `from:` provenance declaration? */
function originMatchesFrom(origin, from) {
  const o = String(origin);
  if (from === "installed") return o.startsWith("installed:");
  if (from === "owned") return o.startsWith("owned:");
  if (from.startsWith("path:")) return o.startsWith("path:");
  return false;
}

/** Resolve targetable capability bindings for one soul. No soul means global bindings only. */
export function resolveCapabilities(contextDir, soulName) {
  const chain = configChain(contextDir);
  const manifests = capabilityManifests(contextDir);
  const soulType = soulTypeOf(contextDir, soulName);
  const candidates = new Map();
  const add = (id, candidate) => {
    const canonical = capabilityManifest(id, contextDir)?.capability || id;
    if (!candidates.has(canonical)) candidates.set(canonical, []);
    candidates.get(canonical).push(candidate);
  };

  chain.forEach((cfg, scope) => {
    for (const { id, spec, slot } of configCapabilityEntries(cfg)) {
      const entrySettings = spec.settings && typeof spec.settings === "object" ? spec.settings : undefined;
      let global = bindingObject(spec.global);
      if (!global && slot && spec.global === undefined && !spec["agent-types"] && !spec.souls) global = { enabled: true };
      if (global) {
        if (entrySettings) global = { ...global, settings: { ...entrySettings, ...(global.settings || {}) } };
        add(id, { binding: global, specificity: 0, scope, level: cfg._level, target: "global", spec, slot });
      }
      if (soulName) {
        let types = spec["agent-types"];
        if (Array.isArray(types)) types = Object.fromEntries(types.map((t) => [t, true]));
        for (const [type, value] of Object.entries(types || {})) {
          if (type !== soulType) continue;
          const binding = bindingObject(value);
          if (binding) add(id, { binding, specificity: 1, scope, level: cfg._level, target: `type:${type}`, spec, slot });
        }
        const binding = bindingObject(spec.souls?.[soulName]);
        if (binding) add(id, { binding, specificity: 2, scope, level: cfg._level, target: `soul:${soulName}`, spec, slot });
      }
    }
  });

  const active = [];
  for (const [id, list] of candidates) {
    // Retirement wins over presence: a stale installed artifact of a retired
    // capability is exactly the state the migration tells users to clean up.
    const retiredReason = retiredCapabilityReason(id);
    if (retiredReason) throw new Error(`capability "${id}" is activated in config but ${retiredReason}`);
    const manifest = manifests[id] || capabilityManifest(id, contextDir);
    if (!manifest) throw new Error(`capability "${id}" is activated but no manifest was acquired`);
    for (const c of list) {
      if (c.slot && manifest.layer !== c.slot) throw new Error(`capability "${id}" is declared under capabilities.layers.${c.slot} (${c.level}) but its manifest declares layer "${manifest.layer || "none"}"`);
      if (!c.slot && manifest.layer) throw new Error(`capability "${id}" declares fundamental layer "${manifest.layer}" — declare it under capabilities.layers.${manifest.layer}, not additive (${c.level})`);
      const from = c.spec?.from;
      if (from !== undefined && !originMatchesFrom(manifest._origin, String(from))) {
        throw new Error(`capability "${id}" declares from: ${from} (${c.level}), but the discovered artifact origin is ${manifest._origin}`);
      }
    }
    const ranked = [...list].sort((a, b) => a.specificity - b.specificity || b.scope - a.scope || a.target.localeCompare(b.target));
    const settings = {};
    const settingRank = {};
    for (const c of ranked) {
      for (const [key, value] of Object.entries(c.binding.settings || {})) {
        const rank = `${c.specificity}:${c.scope}`;
        if (settingRank[key] === rank && JSON.stringify(settings[key]) !== JSON.stringify(value)) {
          throw new Error(`ambiguous capability setting ${id}.${key} at equal specificity (${c.target}, ${c.level})`);
        }
        settings[key] = value; settingRank[key] = rank;
      }
    }
    const strongest = [...list].sort((a, b) => b.specificity - a.specificity || a.scope - b.scope || a.target.localeCompare(b.target));
    const top = strongest[0];
    const tied = strongest.filter((c) => c.specificity === top.specificity && c.scope === top.scope);
    const enabledValues = new Set(tied.map((c) => c.binding.enabled === undefined ? true : !!c.binding.enabled));
    if (enabledValues.size > 1) throw new Error(`ambiguous enabled/excluded bindings for ${id} at equal specificity (${tied.map((c) => c.target).join(", ")})`);
    if (![...enabledValues][0]) continue;
    const compatibility = capabilityCompatibility(manifest);
    if (!compatibility.compatible) throw new Error(`capability "${id}" requires OAS ${compatibility.range}; running ${compatibility.version}`);
    const trust = capabilityTrust(manifest, contextDir);
    if (trust.lock && trust.integrity !== trust.lock.integrity) throw new Error(`locked capability "${id}" is not usable: ${trust.reason}`);
    if (String(manifest._origin).startsWith("installed:") || String(manifest._origin).startsWith("path:")) {
      if (!trust.lock) throw new Error(`external capability "${id}" is not usable: ${trust.reason}`);
    }
    const executable = Object.keys(manifest.commands || {}).length > 0 || Object.keys(manifest.hooks || {}).length > 0;
    const inject = capabilityInject(id, contextDir);
    active.push({
      id, capability: id, manifest, layer: manifest.layer, command: manifest.command,
      level: top.level, origin: manifest._origin, provenance: list.map((c) => `${c.target} @ ${c.level}`),
      settings, skills: capabilitySkillDirs(id, contextDir), inject,
      // What the manifest PROMISES, so preflight can tell "declared nothing"
      // from "declared and missing" — the two are indistinguishable in the
      // resolved lists above.
      skillsDeclared: capabilityDeclaredSkills(id, contextDir),
      injectDeclared: manifest.inject,
      hooks: trust.trusted ? manifestHookCommands(manifest) : {},
      // Required DECLARATIONS are visible regardless of executable trust. Gating
      // them on trust made an untrusted capability's required hook silently not
      // run — spawn warned "executable surface disabled" and started anyway,
      // which is the default state right after a package install and exactly
      // what required:true claims to prevent (aggregate review at 798b156).
      requiredHooks: manifestRequiredHooks(manifest),
      missingRequires: capabilityMissingRequires(id, contextDir), compatibility, trust, executable,
      _scope: top.scope,
    });
  }
  return active.sort((a, b) => b._scope - a._scope || a.id.localeCompare(b.id));
}

/** Resolve config and selected fundamental layers for a context and optional soul. */
export function resolveOasConfig(contextDir, soulName) {
  const chain = configChain(contextDir);
  const out = { layers: {}, provenance: {}, layerDisabled: {}, injects: [], capabilities: [], name: chain[0]?.name, chain };
  // Closest team: declaration wins; the declaring scope is the deployment/team boundary.
  const teamCfg = chain.find((c) => c.team);
  if (teamCfg) out.team = { ...teamCfg.team, scope: teamCfg._level };
  const kernelCfg = chain.find((c) => c.oas && Object.prototype.hasOwnProperty.call(c.oas, "injection-override"));
  const kernelLevel = kernelCfg?._level || resolve(contextDir || process.cwd());
  out.kernelInjection = {
    inject: resolveInjectValue(kernelCfg?.oas?.["injection-override"], kernelLevel, () => packagedInject("oas", contextDir)),
    provenance: kernelCfg ? `oas @ ${kernelCfg._level}` : "default",
  };
  out.capabilities = resolveCapabilities(contextDir, soulName);

  // `capabilities.layers.<layer>: none` explicitly suppresses an inherited fundamental layer.
  for (const layer of LAYERS) {
    for (const cfg of chain) {
      const selection = cfg.capabilities?.layers?.[layer];
      if (selection === undefined || selection === "") continue;
      if (selection !== "none") break; // a capability entry — handled through resolveCapabilities
      out.provenance[layer] = `none @ ${cfg._level}`;
      out.layerDisabled[layer] = { scope: chain.indexOf(cfg), level: cfg._level };
      break;
    }
  }

  // Manifest-declared layer activations fill exclusive fundamental slots.
  for (const cap of [...out.capabilities]) {
    if (!cap.layer) continue;
    const disabled = out.layerDisabled[cap.layer];
    if (disabled && cap._scope === disabled.scope) throw new Error(`fundamental layer ${cap.layer} is explicitly disabled and ${cap.id} is activated at the same config scope (${disabled.level})`);
    if (disabled && cap._scope > disabled.scope) {
      out.capabilities = out.capabilities.filter((c) => c.id !== cap.id);
      continue;
    }
    const current = out.layers[cap.layer];
    if (current && current.id !== cap.id) throw new Error(`fundamental layer ${cap.layer} has multiple active capabilities: ${current.id}, ${cap.id}`);
    if (!current) {
      out.layers[cap.layer] = { ...cap };
      out.provenance[cap.layer] = `${cap.id} [${cap.provenance.join(" + ")}]`;
    }
  }
  out.capabilities.sort((a, b) => b._scope - a._scope || a.id.localeCompare(b.id));
  const commandOwners = {};
  for (const cap of out.capabilities) {
    if (!cap.command) continue;
    if (commandOwners[cap.command] && commandOwners[cap.command] !== cap.id) throw new Error(`duplicate capability command namespace "${cap.command}": ${commandOwners[cap.command]}, ${cap.id}`);
    commandOwners[cap.command] = cap.id;
  }

  for (const cfg of [...chain].reverse()) {
    const inj = cfg["agents-md-injection"];
    if (!inj) continue;
    const entries = typeof inj === "string" ? { [cfg.name || "level"]: inj } : inj;
    for (const [label, p] of Object.entries(entries)) {
      const abs = isAbsolute(p) ? p : join(cfg._level, p);
      if (existsSync(abs)) {
        const item = { source: `${cfg.name || basename(cfg._level)}:${label}`, file: abs };
        const prior = out.injects.findIndex((x) => x.source === item.source);
        if (prior >= 0) out.injects.splice(prior, 1, item); else out.injects.push(item);
      }
    }
  }
  return out;
}

const PACKAGED_INJECTS_DIR = join(PKG_ROOT, "injects");
/** The official marketplace: capability packages shipped with the kernel install.
 * For now this is the kernel package's capabilities/ folder; it will eventually
 * move to its own repo/registry. Marketplace packages are NOT ambient — they are
 * acquired into a scope's installed/ store like any other source. */
export const MARKETPLACE_DIR = join(PKG_ROOT, "capabilities");
/** List marketplace capability ids → manifest (source of `oas install <id>`). */
export function marketplaceCapabilities() {
  const out = {};
  if (!existsSync(MARKETPLACE_DIR)) return out;
  for (const e of readdirSync(MARKETPLACE_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const m = loadManifestAt(join(MARKETPLACE_DIR, e.name), "marketplace");
    if (m) out[m.capability] = m;
  }
  return out;
}
const REPO_ROOT = PKG_ROOT;
const OAS_HOME_DIR = process.env.OAS_HOME_DIR || join(homedir(), ".oas");
/** Legacy pre-v0.8 laptop acquisition root — kept only so doctor can warn about it. */
export const LEGACY_HOME_CAPABILITIES_DIR = join(OAS_HOME_DIR, "capabilities");
export const OAS_LOCK_FILE = "oas-lock.json";
/** Scope-relative capability store subtrees. */
export const CAPABILITIES_DIRNAME = join(".agents", "capabilities");
export const INSTALLED_SUBDIR = "installed";
export const OWNED_SUBDIR = "owned";
export const installedCapabilitiesDir = (level) => join(level, CAPABILITIES_DIRNAME, INSTALLED_SUBDIR);
export const ownedCapabilitiesDir = (level) => join(level, CAPABILITIES_DIRNAME, OWNED_SUBDIR);

/** THE identity grammar for a MATERIALIZED (revised-v2) capability.
 *
 * A materialized capability id is not merely a label: it becomes a DIRECTORY
 * NAME directly under `installed/`, so anything that can steer a filesystem
 * join must be impossible before the join happens. The grammar is deliberately
 * the package-id grammar — namespaced dots are fine, and `/`, `\`, `..`,
 * absolute forms, `@`, and percent-encoded spellings are all outside it.
 *
 * The LEGACY v1 / owned / `from: path:` grammar (loadManifestAt) stays looser
 * on purpose: those artifacts are named by `basename()` of their source, never
 * by the declared id, so the id never reaches a path there. Tightening it would
 * strand already-published standalone capabilities. */
export const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const isMaterializedCapabilityId = (id) => typeof id === "string" && CAPABILITY_ID_RE.test(id);
/** Why a capability id was refused, in one sentence, for every caller's own
 * typed error (the lock parser raises invalid-lock, manifest validation raises
 * invalid-package-manifest — the code each consumer already branches on). */
export const capabilityIdViolation = (id) =>
  `${JSON.stringify(id)} is not a valid capability identity — expected ${CAPABILITY_ID_RE.source} (a namespaced id such as "oas.okf"; path separators, "..", absolute paths, "@" and encoded forms are refused because the id names a directory under ${INSTALLED_SUBDIR}/)`;

function loadManifestAt(idir, origin) {
  const mf = join(idir, "oas.json");
  if (!existsSync(mf)) return undefined;
  let m;
  try { m = JSON.parse(readFileSync(mf, "utf8")); }
  catch (e) { throw new Error(`invalid capability manifest JSON ${mf}: ${e.message}`); }
  const id = m.capability;
  if (!id) throw new Error(`capability manifest needs "capability": ${mf}`);
  if (!/[.@/]/.test(id)) throw new Error(`capability ID must be namespaced: "${id}" (${mf})`);
  if (!m.version || !m.description) throw new Error(`capability ${id} manifest needs version and description`);
  const targetFields = ["global", "groups", "souls", "targets"].filter((key) => Object.prototype.hasOwnProperty.call(m, key));
  if (targetFields.length) throw new Error(`capability ${id} manifest cannot declare config-owned targets: ${targetFields.join(", ")}`);
  if (m.layer && !LAYERS.includes(m.layer)) throw new Error(`capability ${id} declares unknown layer "${m.layer}"`);
  if (m.command && !/^[a-z0-9][a-z0-9-]*$/.test(m.command)) throw new Error(`capability ${id} has invalid command namespace "${m.command}"`);
  for (const [hook, value] of Object.entries(m.hooks || {})) {
    if (!APPROVED_HOOKS.has(hook)) throw new Error(`capability ${id} declares unsupported hook "${hook}"`);
    if (!hookDeclaration(value)) throw new Error(`capability ${id} hook "${hook}" must be a command string or { command, required }`);
    if (value && typeof value === "object" && value.required !== undefined && typeof value.required !== "boolean") {
      throw new Error(`capability ${id} hook "${hook}": "required" must be a boolean`);
    }
    // Only a spawn hook can fail a spawn; marking others required would promise
    // an enforcement that has no defined moment to act.
    if (hookDeclaration(value)?.required && hook !== "spawn") throw new Error(`capability ${id} hook "${hook}" cannot be required — only the spawn hook is enforced (retire and soul-scaffold run outside a spawn transaction)`);
  }
  if (m.agents !== undefined && (!Array.isArray(m.agents) || m.agents.some((a) => typeof a !== "string"))) throw new Error(`capability ${id} "agents" must be an array of package-relative soul directories`);
  return { ...m, _dir: idir, _origin: origin };
}

/** Discover capability manifests. Later sources take precedence: outer scopes < inner scopes; installed < owned within one scope. Duplicates inside one source layer are errors. */
export function capabilityManifests(startDir) {
  const out = {};
  const layer = new Map(); // capability -> origin of the winning manifest
  const add = (m) => {
    if (!m) return;
    if (out[m.capability] && out[m.capability]._dir !== m._dir && layer.get(m.capability) === m._origin) {
      throw new Error(`duplicate capability ID "${m.capability}" from ${out[m.capability]._dir} and ${m._dir}`);
    }
    out[m.capability] = m; layer.set(m.capability, m._origin);
  };
  const loadDir = (dir, origin) => {
    if (!existsSync(dir)) return;
    // Dot-prefixed entries are transaction staging, never installed content.
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".")) add(loadManifestAt(join(dir, e.name), origin));
  };
  if (startDir) {
    for (const cfg of [...configChain(startDir)].reverse()) {
      const store = join(cfg._level, CAPABILITIES_DIRNAME);
      if (existsSync(store)) {
        for (const e of readdirSync(store, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          if (e.name !== INSTALLED_SUBDIR && e.name !== OWNED_SUBDIR) {
            if (existsSync(join(store, e.name, "oas.json"))) throw new Error(`capability at ${join(store, e.name)} must live under ${INSTALLED_SUBDIR}/ (acquired) or ${OWNED_SUBDIR}/ (authored at this scope)`);
          }
        }
      }
      // ONE flat installed store. Materialized package capabilities and legacy v1
      // capability artifacts live side by side under `installed/`, so `from:
      // installed` means "the installed store" regardless of which package (or
      // which era) supplied an entry. Dot-prefixed names are transaction staging.
      loadDir(join(store, INSTALLED_SUBDIR), `installed:${cfg._level}`);
      // Annotate each installed capability from this scope's lock. A strict parse
      // is deliberate: a broken lock must not silently drop provenance or the
      // marketplace annotation (discovery raises; doctor catches the typed error).
      {
        const strict = parseLockFileStrict(join(cfg._level, OAS_LOCK_FILE));
        if (strict) {
          for (const m of Object.values(out)) {
            if (m._origin !== `installed:${cfg._level}`) continue;
            if (Object.hasOwn(strict.capabilities, m.capability)) {
              // Materialized package capability: provenance comes from the lock,
              // and the containment boundary is the artifact itself.
              const row = strict.capabilities[m.capability];
              m._package = row.package;
              m._capabilityLock = row;
              m._packageSource = Object.hasOwn(strict.packages, row.package) ? strict.packages[row.package].source : undefined;
              continue;
            }
            // Legacy v1 marketplace install: still allowed to resolve
            // framework-hoisted resources, and still trusted at acquisition.
            const entry = Object.hasOwn(strict.legacyCapabilities, m.capability) ? strict.legacyCapabilities[m.capability] : undefined;
            if (String(entry?.source || "").startsWith("marketplace:")) {
              m._marketplace = true;
              m._marketplaceLock = { source: entry.source, version: entry.version };
            }
          }
        }
      }
      loadDir(join(store, OWNED_SUBDIR), `owned:${cfg._level}`);
      for (const { spec } of configCapabilityEntries(cfg)) {
        const from = String(spec?.from || "");
        const p = from.startsWith("path:") && from.slice(5);
        if (p) add(loadManifestAt(isAbsolute(p) ? p : join(cfg._level, p), `path:${cfg._level}`));
      }
    }
  }
  return out;
}
export function capabilityManifest(name, startDir) {
  return capabilityManifests(startDir)[name];
}

/** Recursively copy a tree the way `cpSync(..., { recursive: true })` would —
 * except catchably.
 *
 * Node 22's recursive `cpSync` performs its recursion in native code, and on
 * macOS an unreadable directory inside the tree surfaces as an uncaught libc++
 * `filesystem_error` that TERMINATES THE PROCESS. No JS `catch` or `finally`
 * runs, so a transaction using it can never clean up staging or roll back the
 * store, the lock and the ignore file. Every package-, capability- and
 * user-shaped tree in the engine therefore goes through this hand-walk instead,
 * where an EACCES is an ordinary throwable error.
 *
 * Semantics chosen to be safe rather than maximally faithful:
 * - deterministic traversal (sorted entries), so two copies of one tree hash
 *   identically;
 * - symlinks are recreated VERBATIM — never followed, never rewritten — because
 *   the bytes about to be hashed must be the bytes the author wrote;
 * - FIFOs, sockets and device nodes are rejected fail-closed: they are not
 *   distributable content, and copying them has no defined meaning here;
 * - directory modes are applied AFTER their children, so a read-only source
 *   directory cannot block writing its own contents. */
export function copyTreeSafe(src, dest) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(src), dest); return; }
  if (st.isFile()) { copyFileSync(src, dest); chmodSync(dest, st.mode & 0o7777); return; }
  if (!st.isDirectory()) {
    throw oasError("invalid-source", `${src} is not a regular file, directory or symlink (${st.isFIFO() ? "FIFO" : st.isSocket() ? "socket" : st.isBlockDevice() || st.isCharacterDevice() ? "device node" : "unsupported file type"}) — package and capability trees carry distributable content only`);
  }
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    copyTreeSafe(join(src, e.name), join(dest, e.name));
  }
  chmodSync(dest, st.mode & 0o7777);
}

/** Remove source-control metadata from the ROOT of a managed artifact.
 *
 * It must not be installed, and it must not become an integrity exclusion:
 * excluded-but-present bytes are mutable, approval-invisible input. Nested
 * `.git` names are ordinary payload and stay hashed/contained. */
function stripArtifactVcsRoot(dir) {
  const vcs = join(dir, ".git");
  const existed = existsSync(vcs);
  rmSync(vcs, { recursive: true, force: true });
  return existed;
}

/** Stable capability integrity over every managed byte. Acquisition strips
 * root VCS metadata first; any later `.git` insertion therefore changes trust.
 * Only the generated root lock file is excluded. */
export function capabilityIntegrity(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d === dir && e.name === OAS_LOCK_FILE) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { hash.update(relative(dir, p)); hash.update("\0file\0"); hash.update(readFileSync(p)); hash.update("\0"); }
      else if (e.isSymbolicLink()) { hash.update(relative(dir, p)); hash.update("\0symlink\0"); hash.update(readlinkSync(p)); hash.update("\0"); }
    }
  };
  walk(dir);
  return `sha256-${hash.digest("hex")}`;
}
export function readCapabilityLocks(startDir) {
  const out = {};
  for (const cfg of [...configChain(startDir)].reverse()) {
    const file = join(cfg._level, OAS_LOCK_FILE);
    // ONE strict parser: an invalid lock RAISES typed invalid-lock here too —
    // executable trust must never be served from a file the central parser
    // rejects (reviewer-16acf8c blocker; only doctor catches the typed error).
    const strict = parseLockFileStrict(file);
    if (!strict) continue;
    // v1 capability entries only. A converted scope has none, and its
    // materialized capabilities are served by the capability rows instead.
    for (const [id, lock] of Object.entries(strict.legacyCapabilities)) {
      out[id] = { ...lock, _file: file };
    }
  }
  return out;
}
export function writeCapabilityLock(levelDir, id, lock) {
  const file = join(levelDir, OAS_LOCK_FILE);
  // ONE strict parser: malformed roots/shapes are typed invalid-lock before
  // any dereference (reviewer-038b6cb).
  const strict = parseLockFileStrict(file);
  // v1 IS this writer's only format: it services legacy capability acquisition
  // and trust in scopes that have not been converted yet. It must never
  // downgrade or rewrite a converted lock — capability materialization has its
  // own rows and its own writers.
  if (strict && strict.version !== 1) throw oasError("legacy-lock", `${file} is lockfileVersion ${strict.version} — legacy capability locks cannot be written into a capability-materialization lock; install a package instead`, [{ file, package: id }]);
  const parsed = strict
    ? { lockfileVersion: 1, capabilities: { ...strict.legacyCapabilities } }
    : { lockfileVersion: 1, capabilities: {} };
  parsed.capabilities ||= {}; parsed.capabilities[id] = lock;
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
  return file;
}

/** Keep MATERIALIZED artifacts uncommitted (like node_modules) while `owned/`
 * commits. It ignores `installed/` and nothing else: `owned/` holds authored
 * capabilities and `.agents/config-templates/adopted/` holds portable adopted
 * bases — both are meant to be reviewed and committed, so neither is ever
 * ignored or touched here.
 *
 * This is PART OF THE TRANSACTION, not post-commit convenience (maintainer
 * ruling): generated artifacts must never be able to enter a commit, so at a Git
 * scope the ignore is ensured BEFORE any artifact or lock mutation and FAILS the
 * operation if it cannot be written. `ensureInstalledGitignorePreflight` returns
 * the undo needed to restore the prior bytes (or absence) if the transaction
 * later fails.
 *
 * Outside version control it is a no-op returning false: a non-Git scope uses
 * the same layout without pretending Git owns its durability. */
export function ensureInstalledGitignore(levelDir) {
  return ensureInstalledGitignorePreflight(levelDir).changed;
}
/** @returns {{ changed: boolean, rollback: () => void }} */
export function ensureInstalledGitignorePreflight(levelDir) {
  const noop = { changed: false, rollback: () => {} };
  if (!spawnSyncOk("git", ["-C", levelDir, "rev-parse", "--is-inside-work-tree"])) return noop;
  const store = join(levelDir, CAPABILITIES_DIRNAME);
  const file = join(store, ".gitignore");
  const line = `${INSTALLED_SUBDIR}/`;
  const existed = existsSync(file);
  const current = existed ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === line)) return noop;
  try {
    mkdirSync(store, { recursive: true });
    writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + `# OAS: materialized capabilities are reprojected from oas-lock.json by \`oas install\`.\n${line}\n`);
  } catch (e) {
    throw oasError("path-escape", `cannot ensure ${file} ignores "${line}": ${e.message} — generated capability artifacts must never be committable, so the operation stops before touching the store or the lock`, [{ file }]);
  }
  return {
    changed: true,
    rollback: () => {
      try { if (existed) writeFileSync(file, current); else rmSync(file, { force: true }); } catch { /* nothing better to do during rollback */ }
    },
  };
}
function spawnSyncOk(cmd, argv) {
  try { execFileSync(cmd, argv, { stdio: "ignore" }); return true; } catch { return false; }
}

/** Acquire one capability artifact into a scope's installed/ store and return its manifest + integrity.
 * Sources: a marketplace id (e.g. "oas.jira"), a git URL, or a local path. */
export function acquireCapability(levelDir, src, { expectIntegrity, rootSnapshot } = {}) {
  const retiredReason = retiredCapabilityReason(src);
  if (retiredReason) throw oasError("retired-capability", retiredReason);
  const isUrl = /^(https?:\/\/|file:\/\/|git@|ssh:\/\/)/.test(src);
  const isPath = !isUrl && (src.startsWith(".") || src.startsWith("/") || src.startsWith("~"));
  const market = !isUrl && !isPath ? marketplaceCapabilities()[src] : undefined;
  if (!isUrl && !isPath && !market) throw new Error(`"${src}" is not a marketplace capability id, git URL, or local path (marketplace: ${Object.keys(marketplaceCapabilities()).join(", ") || "none"})`);
  const from = isPath ? resolve(src.replace(/^~\//, `${homedir()}/`)) : market ? market._dir : undefined;
  if (from && !existsSync(join(from, "oas.json"))) throw new Error(`${from} has no oas.json capability manifest`);
  const destRoot = installedCapabilitiesDir(levelDir);
  const dest = join(destRoot, market ? basename(market._dir) : basename(src).replace(/\.git$/, ""));
  if (existsSync(dest)) throw new Error(`${dest} already exists — OAS never silently updates a locked package; remove it or use an explicit upgrade workflow`);
  mkdirSync(destRoot, { recursive: true });
  try {
    if (rootSnapshot) {
      copyTreeSafe(rootSnapshot.dir, dest);
      if (existsSync(join(dest, "oas-package.json")) !== rootSnapshot.package || existsSync(join(dest, "oas.json")) !== rootSnapshot.capability || !rootSnapshot.capability || rootSnapshot.package) {
        throw oasError("invalid-source", `inspected Git root layout changed before standalone capability acquisition: ${src}`);
      }
    } else if (isUrl) execFileSync("git", ["clone", "-q", src, dest], { stdio: "inherit" });
    else execFileSync("cp", ["-R", from, dest]);
    stripArtifactVcsRoot(dest);
    if (!existsSync(join(dest, "oas.json"))) throw new Error(`installed artifact has no oas.json: ${dest}`);
    const manifest = JSON.parse(readFileSync(join(dest, "oas.json"), "utf8"));
    if (!manifest.capability) throw new Error("manifest needs a namespaced capability ID");
    // Retirement applies to the acquired manifest's ID too: a local path or
    // git URL can carry a package whose oas.json declares a retired
    // capability that can never be activated (catch below removes dest).
    const retiredReason = retiredCapabilityReason(manifest.capability);
    if (retiredReason) throw oasError("retired-capability", `this package declares capability "${manifest.capability}" — ${retiredReason}`);
    const integrity = capabilityIntegrity(dest);
    if (expectIntegrity && integrity !== expectIntegrity) {
      throw new Error(`restored artifact integrity ${integrity} does not match locked ${expectIntegrity}; the source has drifted — reacquire explicitly`);
    }
    const commit = rootSnapshot?.commit || (isUrl ? execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() : undefined);
    ensureInstalledGitignore(levelDir);
    const source = market ? `marketplace:${manifest.capability}@${manifest.version}` : `${isUrl ? "git" : "path"}:${isUrl ? src : from}`;
    return { manifest, dest, integrity, commit, source, marketplace: !!market };
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/** Restore every locked capability in the chain whose artifact is missing. Walks lockfiles (a lock can exist at a scope without a config). Returns a report list.
 * opts.levels: restore EXACTLY these lock levels (no upward walk) — used by
 * workspace reconciliation to process each scope's lock graph once. */
export function restoreCapabilities(startDir, { levels: onlyLevels } = {}) {
  const report = [];
  let levels = [];
  if (onlyLevels) {
    levels = onlyLevels.filter((d) => existsSync(join(d, OAS_LOCK_FILE))).map((d) => resolve(d));
  } else {
    for (let d = resolve(startDir); ; d = dirname(d)) {
      if (existsSync(join(d, OAS_LOCK_FILE))) levels.push(d);
      if (dirname(d) === d) break;
    }
    levels.reverse();
  }
  // Preflight/cache the COMPLETE visible chain before the first restore. A
  // malformed inner lock must not be discovered after an outer artifact was
  // already installed (reviewer-fe42de8). (levels is already ordered
  // outermost-first above, for both the onlyLevels and walk-up forms.)
  const locks = levels.map((level) => {
    const file = join(level, OAS_LOCK_FILE);
    return { level, file, strict: parseLockFileStrict(file) };
  });
  for (const { level, file, strict } of locks) {
    if (!strict) continue;
    for (const [id, lock] of Object.entries(strict.legacyCapabilities)) {
      // Retirement wins over EVERYTHING (including entry-shape validation):
      // the actionable migration diagnostic must never be masked by a shape
      // complaint about an entry the user is being told to delete anyway.
      const retiredReason = retiredCapabilityReason(id);
      if (retiredReason) { report.push({ id, level, status: "retired", reason: retiredReason }); continue; }
      const violation = legacyCapabilityEntryViolation(lock);
      if (violation) throw oasError("invalid-lock", `${file}: legacy entry "${id}" is malformed (${violation})`, [{ file, package: id, violation }]);
      const present = capabilityManifest(id, startDir);
      if (present) {
        const prunedVcs = stripArtifactVcsRoot(present._dir);
        report.push({ id, level, status: "present", dir: present._dir, ...(prunedVcs ? { repaired: "removed root .git metadata" } : {}) });
        continue;
      }
      const src = String(lock.source || "");
      const [kind, ...rest] = src.split(":"); const location = rest.join(":");
      const restoreSrc = kind === "marketplace" ? location.replace(/@[^@]*$/, "") : location;
      if (kind !== "git" && kind !== "path" && kind !== "marketplace") { report.push({ id, level, status: "unrestorable", reason: `unknown source "${src}"` }); continue; }
      try {
        const r = acquireCapability(level, restoreSrc, { expectIntegrity: lock.integrity });
        if (r.manifest.capability !== id) { rmSync(r.dest, { recursive: true, force: true }); throw new Error(`source now provides "${r.manifest.capability}", lock expects "${id}"`); }
        report.push({ id, level, status: "restored", dir: r.dest, integrity: r.integrity });
      } catch (e) {
        report.push({ id, level, status: "failed", reason: e.message, ...(e.code ? { code: e.code } : {}) });
      }
    }
  }
  return report;
}
/** Trust query. TWO call shapes:
 *  - contract (docs/design/package-engine-contract.md §3): capabilityTrust(startDir, capabilityId)
 *    → { trusted, package, integrity, executableSurface: { commands, hooks }, reason? }
 *  - internal/legacy: capabilityTrust(manifest, startDir) (resolver + CLI dispatch path). */
export function capabilityTrust(a, b) {
  if (typeof a === "string") {
    const startDir = a, capabilityId = b;
    const manifest = capabilityManifest(capabilityId, startDir);
    const t = manifestTrust(manifest, startDir);
    const surface = { commands: Object.keys(manifest?.commands || {}), hooks: Object.keys(manifest?.hooks || {}) };
    return { ...t, package: t.package || manifest?._package, executableSurface: surface };
  }
  return manifestTrust(a, b);
}
function manifestTrust(manifest, startDir, requireExecutableApproval = true) {
  if (!manifest) return { trusted: false, reason: "manifest missing" };
  const origin = String(manifest._origin);
  if (origin.startsWith("owned:") || (!requireExecutableApproval && origin.startsWith("path:"))) return { trusted: true, configOwned: true };
  const executable = requireExecutableApproval && (Object.keys(manifest.commands || {}).length > 0 || Object.keys(manifest.hooks || {}).length > 0);
  if (manifest._package) {
    // Materialized package capability: trust binds to the capability ARTIFACT's
    // exact integrity — which covers its source, its materialized runtime
    // closure and its provenance file, so post-approval tampering with any of
    // them invalidates trust — plus that capability's own approval flag. There
    // is no package-level approval and no separate dependency digest.
    const locks = readPackageLocks(startDir); // raises invalid-lock (fail closed — only doctor catches)
    if (!Object.hasOwn(locks.capabilities, manifest.capability)) return { trusted: false, reason: `capability ${manifest.capability} is not locked in ${OAS_LOCK_FILE}` };
    const row = locks.capabilities[manifest.capability];
    // The PROVIDER is resolved at the capability's own lock level, not from the
    // merged map: an inner scope locking the same package id at another version
    // must not supply provenance for an outer scope's capability.
    const pkgRow = providerPackageRow(locks, row);
    if (!pkgRow) return { trusted: false, reason: `provider package ${row.package} is not locked in ${row._file}` };
    const integrity = capabilityArtifactIntegrity(manifest._dir);
    if (row.integrity !== integrity) return { trusted: false, reason: `capability ${manifest.capability} artifact integrity differs from ${row._file}`, integrity, lock: row };
    // Provenance and lock must tell the same story before either is believed.
    try { verifyCapabilityInstallation(manifest._dir, manifest.capability, row, pkgRow); }
    catch (e) { return { trusted: false, reason: e.message, integrity, lock: row }; }
    if (executable && row.trusted !== true) {
      return { trusted: false, reason: `executable commands/hooks need \`oas trust ${manifest.capability}\``, integrity, lock: row };
    }
    return { trusted: true, integrity, lock: row, package: row.package };
  }
  const lock = readCapabilityLocks(startDir)[manifest.capability];
  if (!lock) return { trusted: false, reason: `not locked in ${OAS_LOCK_FILE}` };
  const integrity = capabilityIntegrity(manifest._dir);
  if (lock.integrity !== integrity) return { trusted: false, reason: `integrity differs from ${lock._file}`, integrity, lock };
  if (executable && !lock.trustedExecutables) return { trusted: false, reason: "executable commands/hooks need `oas trust`", integrity, lock };
  return { trusted: true, integrity, lock };
}
export function capabilityCompatibility(manifest, version = OAS_VERSION) {
  const range = manifest?.compatibility?.oas;
  if (!range) return { compatible: true };
  const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const current = parse(version);
  let compatible = true;
  if (String(range).startsWith(">=")) compatible = cmp(current, parse(String(range).slice(2))) >= 0;
  else if (/^\d+\.\d+\.\d+$/.test(String(range))) compatible = cmp(current, parse(range)) === 0;
  else if (String(range).startsWith("^")) { const wanted = parse(String(range).slice(1)); compatible = current[0] === wanted[0] && cmp(current, wanted) >= 0; }
  return { compatible, range, version };
}

// ---------- distribution packages (docs/design/package-engine-contract.md) ----------
/** Kernel error with a stable machine-readable code (contract §4) and optional provenance. */
export function oasError(code, message, provenance) {
  const e = new Error(message);
  e.code = code;
  if (provenance) e.provenance = provenance;
  return e;
}

/** Where one materialized capability artifact lives at a scope.
 *
 * This is the LAST line of defence, and it is a positive proof rather than a
 * blocklist: the id must match the materialized grammar, and the lexically
 * resolved destination must be an IMMEDIATE child of `installed/`. Nothing is
 * derived from the id before it is validated, so a hostile id cannot influence
 * the path it is being checked against. */
export const installedCapabilityDir = (levelDir, capabilityId) => {
  if (!isMaterializedCapabilityId(capabilityId)) throw oasError("path-escape", `capability artifact path refused: ${capabilityIdViolation(capabilityId)}`);
  const root = installedCapabilitiesDir(levelDir);
  const dir = join(root, capabilityId);
  // Lexical, not realpath: this proves the NAME cannot walk out of the store.
  // Symlink containment of the store itself is a separate, earlier concern.
  if (dirname(resolve(dir)) !== resolve(root)) {
    throw oasError("path-escape", `capability artifact path refused: ${JSON.stringify(capabilityId)} does not resolve to an immediate child of ${root}`);
  }
  return dir;
};
/** Generated provenance file inside every materialized artifact. It is INSIDE
 * the hashed tree, so tampering with it is integrity drift; the lock stays
 * authoritative. */
export const CAPABILITY_INSTALLATION_FILE = ".oas-installation.json";
/** Prefix of a transaction staging directory. It lives inside the (gitignored)
 * installed store so the commit phase is a same-filesystem rename, and it is
 * dot-prefixed so discovery skips it. */
const STAGING_PREFIX = ".staging-";

/** Default contained package root inside a Git/catalog source when the source
 * contract does not select one (contract §2). NEVER a hardcoded directory at a
 * use site: every resolver reads the configured path and falls back here. */
export const DEFAULT_PACKAGE_PATH = "oas-package";

/** Normalize a configured package path to its canonical form, or throw.
 *
 * Canonical form is a POSIX-relative path with no redundant or trailing
 * separators; every spelling of the repository root ("", ".", "./", "./.")
 * normalizes to the single canonical "." so a root selection round-trips
 * identically through spec → lock → JSON → doctor/list/update (contract §4).
 *
 * Fail-closed: absolute paths, Windows drive paths, host-ambient "~" spellings,
 * backslash separators (ambiguous — a backslash is a legal POSIX filename
 * character, so accepting it as a separator would make containment checks
 * disagree with the filesystem) and NUL are rejected as invalid-source; ".."
 * traversal is path-escape. Returns undefined ONLY for an absent value, so the
 * caller can apply the source-appropriate default. */
export function normalizePackagePath(raw, { where = "package path", code = "invalid-source" } = {}) {
  // ABSENT means absent. A present `null` (JSON's way of spelling a malformed
  // value) is a violation, not a fall-through to the caller's default — a
  // catalog entry that says `"path": null` must fail, not silently install
  // DEFAULT_PACKAGE_PATH.
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw oasError(code, `${where} must be a string (got ${Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw})`);
  const s = raw.trim();
  if (s.includes("\0")) throw oasError(code, `${where} contains a NUL byte`);
  if (s.startsWith("~")) throw oasError(code, `${where} "${s}" is a host-ambient path — package paths are repository-relative`);
  if (s.includes("\\")) throw oasError(code, `${where} "${s}" uses backslashes — package paths are POSIX-relative (use "/")`);
  if (/^[A-Za-z]:[/\\]/.test(s)) throw oasError(code, `${where} "${s}" is an absolute drive path — package paths are repository-relative`);
  if (isAbsolute(s)) throw oasError(code, `${where} "${s}" is absolute — package paths are repository-relative`);
  const segments = s.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.includes("..")) throw oasError("path-escape", `${where} "${s}" escapes the source root with ".."`);
  return segments.length ? segments.join("/") : ".";
}

/** Split an optional `#<package-path>` fragment off a source spec. A source may
 * carry at most one fragment; the fragment is removed BEFORE `@ref` parsing so
 * a path can never be mistaken for part of a ref. */
function splitPackagePathFragment(spec) {
  const hash = spec.indexOf("#");
  if (hash < 0) return { body: spec, fragment: undefined };
  const fragment = spec.slice(hash + 1);
  if (fragment.includes("#")) throw oasError("invalid-source", `package source "${spec}" has more than one "#<path>" fragment`);
  return { body: spec.slice(0, hash), fragment };
}

/** Parse + normalize a package source spec (contract §1): git shorthand, raw
 * git URL, local path, or official catalog short ID. Git spellings accept an
 * optional `#<path>` fragment selecting a contained package root; the parsed
 * `packagePath` is undefined when the spec does not select one (resolution
 * applies DEFAULT_PACKAGE_PATH or the catalog entry's path). */
export function parsePackageSource(spec, { baseDir } = {}) {
  const raw = String(spec ?? "").trim();
  if (!raw) throw oasError("invalid-source", "empty package source");
  const { body: s, fragment } = splitPackagePathFragment(raw);
  if (!s) throw oasError("invalid-source", `package source "${raw}" selects a path but names no source`);
  const packagePath = normalizePackagePath(fragment, { where: `package path in "${raw}"` });
  // Fragments belong to Git sources only. A catalog entry supplies its own
  // path ({url, ref?, path?}) and a local path is an EXACT directory
  // (contract §9) — accepting "#" on either would create a second, ambiguous
  // way to spell the same selection.
  const noFragment = (kind) => {
    if (fragment !== undefined) throw oasError("invalid-source", `${kind} sources do not take a "#<path>" fragment: "${raw}"`);
  };
  const splitRef = (str) => {
    const at = str.lastIndexOf("@");
    if (at > 0 && at > str.lastIndexOf("/")) return [str.slice(0, at), str.slice(at + 1)];
    return [str, undefined];
  };
  const asPath = (raw) => {
    // Classify BEFORE tilde expansion (reviewer-3626ef2 blocker): `~/x` is a
    // host-ambient spelling, not an absolute path — expanding first turned it
    // absolute and let remote manifests reach $HOME through the guard.
    const tilde = raw.startsWith("~/") || raw === "~";
    const expanded = tilde ? raw.replace(/^~(?=\/|$)/, homedir()) : raw;
    // Relativeness from the PARSED payload (reviewer-2a4adec: "path:sub" and
    // whitespace variants are relative too). Tilde spellings are NOT absolute
    // for classification purposes: they are ambient-host references, treated
    // like relative specs so the no-local-base guard rejects them from
    // git/catalog manifests.
    const relativeSpec = tilde || !isAbsolute(expanded);
    // Relative paths resolve against baseDir when provided (the depending
    // package's root — contract: package-relative), else the process CWD.
    // Tilde stays home-anchored (never baseDir-joined) for CLI use.
    const p = tilde ? resolve(expanded) : baseDir && relativeSpec ? resolve(baseDir, expanded) : resolve(expanded);
    // Local acquisition is EXACT-DIRECTORY (contract §9): the named directory
    // IS the package root whatever it is called — no default-path heuristic.
    return { kind: "path", path: p, relative: relativeSpec, packagePath: ".", normalized: `path:${p}` };
  };
  if (s.startsWith("path:")) { noFragment("local path"); return asPath(s.slice(5)); }
  if (s.startsWith(".") || s.startsWith("/") || s.startsWith("~")) { noFragment("local path"); return asPath(s); }
  if (s.startsWith("git:") && !s.startsWith("git://")) {
    const [body, ref] = splitRef(s.slice(4));
    if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(body)) throw oasError("invalid-source", `git shorthand must be git:host/org/repo[@ref][#<path>]: "${spec}"`);
    const url = `https://${body}${body.endsWith(".git") ? "" : ".git"}`;
    return { kind: "git", url, ref, packagePath, normalized: ref ? `git:${url}@${ref}` : `git:${url}` };
  }
  if (/^(https?:\/\/|file:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s)) {
    const [url, ref] = splitRef(s);
    return { kind: "git", url, ref, packagePath, normalized: ref ? `git:${url}@${ref}` : `git:${url}` };
  }
  const m = /^([a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(s);
  if (m) {
    noFragment("official catalog");
    return { kind: "catalog", id: m[1], selector: m[2], normalized: m[2] ? `catalog:${m[1]}@${m[2]}` : `catalog:${m[1]}` };
  }
  throw oasError("invalid-source", `"${spec}" is not a git source, local path, or official catalog id`);
}

/** Inspect a Git source's fetched layout before choosing package vs legacy
 * capability acquisition. No scope/lock preflight or mutation occurs.
 *
 * `dir`/`package`/`capability` describe the REPOSITORY ROOT and are what the
 * legacy standalone-capability path consumes, unchanged. `payloadDir` /
 * `payloadPackage` / `payloadCapability` describe the SELECTED contained
 * package root (`path`) and are what package acquisition consumes; `payloadDir`
 * is undefined when the configured path names no directory in this checkout.
 * A configured path that escapes the checkout — including through a symlink,
 * or a broken one — throws path-escape here, before any scope is touched. */
export function inspectGitSourceRoot(spec) {
  const parsed = parsePackageSource(spec);
  if (parsed.kind !== "git") throw oasError("invalid-source", `Git root inspection requires a Git source: ${spec}`);
  const packagePath = parsed.packagePath ?? DEFAULT_PACKAGE_PATH;
  const tmp = mkdtempSync(join(tmpdir(), "oas-git-root-"));
  const root = join(tmp, "root");
  try {
    execFileSync("git", ["clone", "-q", parsed.url, root], { stdio: "pipe" });
    const commit = parsed.ref
      ? gitCheckoutExactRef(root, parsed.ref, spec)
      : execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw oasError("invalid-source", `Git inspection did not resolve an exact commit for ${spec}`);
    const payloadDir = resolvePackagePayloadDir(root, packagePath, spec);
    return {
      package: existsSync(join(root, "oas-package.json")), capability: existsSync(join(root, "oas.json")), dir: root,
      payloadDir, payloadPackage: !!payloadDir && existsSync(join(payloadDir, "oas-package.json")),
      payloadCapability: !!payloadDir && existsSync(join(payloadDir, "oas.json")),
      commit, path: packagePath, explicitPath: parsed.packagePath !== undefined,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
}

/** Parse a lock entry's `source` against the EXACT normalized grammar the
 * writer produces. Strict on purpose: `updatePackage` turns this back into a
 * source spec, so a payload that merely "starts with catalog:" but is not a
 * valid catalog id gets RECLASSIFIED downstream — `catalog:../evil` would be
 * re-parsed as a host-relative local path and acquired from the operator's
 * filesystem. A lock also never carries a `#<path>` fragment: the selected
 * root is the entry's own `path` field, and a fragment here would produce a
 * double-fragment spec on update. */
function parseLockSource(src) {
  const s = String(src || "");
  const bad = (why) => oasError("invalid-source", `unknown lock source "${src}" — ${why}`);
  if (s.includes("#")) throw bad(`lock sources carry no "#<path>" fragment; the selected package root is the entry's "path" field`);
  if (s.startsWith("path:")) {
    const p = s.slice(5);
    if (!p) throw bad("empty path source");
    if (!isAbsolute(p)) throw bad("path source must be an absolute directory (the writer always resolves it)");
    return { kind: "path", path: p, normalized: s };
  }
  if (s.startsWith("catalog:")) {
    const body = s.slice(8);
    // Split at the FIRST "@", mirroring the public parser's regex: the catalog
    // id grammar cannot contain "@", so everything after the first one is the
    // selector. Splitting at the LAST "@" misreads a legitimate ref spelling
    // such as `oas.okf@release@candidate` — which the writer does produce —
    // as the id `oas.okf@release`.
    const at = body.indexOf("@");
    const id = at > 0 ? body.slice(0, at) : body;
    const selector = at > 0 ? body.slice(at + 1) : undefined;
    if (!PACKAGE_ID_RE.test(id)) throw bad(`"${id}" is not a valid official catalog id`);
    if (at > 0 && !selector) throw bad("empty catalog selector");
    return { kind: "catalog", id, selector, normalized: s };
  }
  if (s.startsWith("git:")) {
    const body = s.slice(4);
    const at = body.lastIndexOf("@") > body.lastIndexOf("/") ? body.lastIndexOf("@") : -1;
    const url = at > 0 ? body.slice(0, at) : body;
    const ref = at > 0 ? body.slice(at + 1) : undefined;
    if (!url) throw bad("empty git url");
    if (at > 0 && !ref) throw bad("empty git ref");
    if (!/^(https?:\/\/|file:\/\/|git@|ssh:\/\/|git:\/\/)/.test(url)) throw bad(`"${url}" is not an http(s)/ssh/file/git URL`);
    return { kind: "git", url, ref, normalized: s };
  }
  throw oasError("invalid-source", `unknown lock source "${src}"`);
}

/** Official package catalog: identity + discovery ONLY — resolving through it
 * never advances a lock and never grants executable trust (contract §1).
 * Workstream 3 seeds the kernel-bundled catalog; OAS_PACKAGE_CATALOG points
 * tests/deployments at an alternate catalog JSON ({ packages: { <id>: { url, ref? } } }). */
export function officialPackageCatalog() {
  return readCatalogFile().packages;
}
/** Parse the catalog file once: { packages: { <id>: { url, ref?, path? } },
 * capabilities?: { <legacy capability id>: <package id> } }. Both maps are
 * returned with a null prototype so inherited Object.prototype names can never
 * impersonate a catalog entry. */
function readCatalogFile() {
  const file = process.env.OAS_PACKAGE_CATALOG || join(PKG_ROOT, "package-catalog.json");
  const empty = { packages: Object.create(null), capabilities: Object.create(null), file };
  if (!existsSync(file)) return empty;
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { throw oasError("invalid-source", `broken package catalog ${file}: ${e.message}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw oasError("invalid-source", `broken package catalog ${file}: root must be a JSON object`);
  const out = { packages: Object.create(null), capabilities: Object.create(null), file };
  const packages = doc.packages;
  if (packages !== undefined) {
    if (packages === null || typeof packages !== "object" || Array.isArray(packages)) throw oasError("invalid-source", `broken package catalog ${file}: "packages" must be an object map`);
    for (const [id, entry] of Object.entries(packages)) out.packages[id] = entry;
  }
  // Capability aliases (0.19.1 migration contract): legacy capability id →
  // official package id. Identity mappings (package id == capability id) need
  // no entry; an alias exists for capabilities a package exports under another
  // package identity (oas.review is exported by package oas.dev).
  const aliases = doc.capabilities;
  if (aliases !== undefined) {
    if (aliases === null || typeof aliases !== "object" || Array.isArray(aliases)) throw oasError("invalid-source", `broken package catalog ${file}: "capabilities" must be a map of capability id → package id`);
    for (const [capId, target] of Object.entries(aliases)) {
      const pkgId = typeof target === "string" ? target : (target && typeof target === "object" && !Array.isArray(target) ? target.package : undefined);
      if (typeof pkgId !== "string" || !PACKAGE_ID_RE.test(pkgId)) throw oasError("invalid-source", `broken package catalog ${file}: capability alias "${capId}" must name a package id (string, or { "package": "<id>" })`);
      if (!PACKAGE_ID_RE.test(capId)) throw oasError("invalid-source", `broken package catalog ${file}: capability alias key "${capId}" is not a valid capability id`);
      out.capabilities[capId] = pkgId;
    }
  }
  return out;
}

/** The catalog's legacy-capability → official-package aliases (null-prototype). */
export function officialCapabilityAliases() {
  return readCatalogFile().capabilities;
}

/** Which official package supplies a legacy (v1, `marketplace:`) capability.
 * Alias first, then identity (package id == capability id); `available` says
 * whether the catalog can actually resolve that package today, which is what
 * makes guided official migration possible or not on a given release. */
export function officialCapabilityPackage(capId, { catalog, aliases } = {}) {
  const resolveCatalog = catalog || defaultCatalogResolve;
  const map = aliases || officialCapabilityAliases();
  const aliased = Object.hasOwn(map, capId);
  const pkg = aliased ? map[capId] : capId;
  return { capability: capId, package: pkg, via: aliased ? "alias" : "identity", available: !!resolveCatalog(pkg) };
}

function defaultCatalogResolve(id, selector) {
  const packages = readCatalogFile().packages;
  const e = Object.hasOwn(packages, id) ? packages[id] : undefined;
  if (!e || !e.url) return undefined;
  // The entry's `path` is part of the catalog contract ({ url, ref?, path? }):
  // dropping it here would make every real catalog install fall back to
  // DEFAULT_PACKAGE_PATH while only injected test resolvers honored it.
  return { url: e.url, ref: selector || e.ref, path: e.path };
}

/** Stable package integrity: every managed source byte except materialized
 * runtime deps (node_modules), which live inside capability artifacts and are
 * covered by capabilityArtifactIntegrity instead. Acquisition
 * strips root VCS metadata; a later `.git` insertion is therefore integrity
 * drift, never an invisible exclusion. */
export function packageIntegrity(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ((d === dir && e.name === OAS_LOCK_FILE) || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { hash.update(relative(dir, p)); hash.update("\0file\0"); hash.update(readFileSync(p)); hash.update("\0"); }
      else if (e.isSymbolicLink()) { hash.update(relative(dir, p)); hash.update("\0symlink\0"); hash.update(readlinkSync(p)); hash.update("\0"); }
    }
  };
  walk(dir);
  return `sha256-${hash.digest("hex")}`;
}

/** Stable integrity of a MATERIALIZED capability artifact: every byte under
 * `.agents/capabilities/installed/<id>/`, with NO exclusions — capability source,
 * the materialized runtime closure (node_modules), and the generated
 * `.oas-installation.json` provenance file all count. This is the only digest
 * executable trust binds to, which is why a separate dependency digest does not
 * exist at capability level: the closure is inside the artifact, so tampering
 * with a dependency is ordinary artifact drift. */
export function capabilityArtifactIntegrity(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { hash.update(relative(dir, p)); hash.update("\0file\0"); hash.update(readFileSync(p)); hash.update("\0"); }
      else if (e.isSymbolicLink()) { hash.update(relative(dir, p)); hash.update("\0symlink\0"); hash.update(readlinkSync(p)); hash.update("\0"); }
    }
  };
  walk(dir);
  return `sha256-${hash.digest("hex")}`;
}

const PACKAGE_MANIFEST_KEYS = new Set(["package", "version", "description", "compatibility", "capabilities", "configTemplates", "configs", "dependencies"]);
/** Load + validate an oas-package.json (schema semantics of docs/oas-package.schema.json,
 * plus containment: every declared path must stay inside the package root after
 * symlink resolution and identify the expected resource kind). Returns the
 * manifest with:
 *   _dir             the package root
 *   _legacySpelling  true when the DEPRECATED `configs` key was used (diagnostic
 *                    only — it is NOT what permits a "." capability root)
 *   _configTemplates normalized { name: { path, description?, default } } from
 *                    whichever spelling the manifest used
 *   _capabilities    [{ id, rel, dir, manifest }]
 */
export function loadPackageManifestAt(pdir) {
  const mf = join(pdir, "oas-package.json");
  if (!existsSync(mf)) throw oasError("invalid-package-manifest", `${pdir} has no oas-package.json distribution manifest`);
  let m;
  try { m = JSON.parse(readFileSync(mf, "utf8")); }
  catch (e) { throw oasError("invalid-package-manifest", `invalid JSON in ${mf}: ${e.message}`); }
  // Hostile-input shapes: JSON null/scalar/array roots are valid JSON but not manifests.
  if (!m || typeof m !== "object" || Array.isArray(m)) throw oasError("invalid-package-manifest", `${mf} must be a JSON object (got ${m === null ? "null" : Array.isArray(m) ? "array" : typeof m})`);
  if (typeof m.package !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(m.package)) throw oasError("invalid-package-manifest", `${mf} needs a valid string "package" identity (lowercase [a-z0-9._-])`);
  if (typeof m.version !== "string" || !m.version || typeof m.description !== "string" || !m.description) throw oasError("invalid-package-manifest", `package ${m.package} manifest needs string version and description`);
  const unknown = Object.keys(m).filter((k) => !PACKAGE_MANIFEST_KEYS.has(k));
  if (unknown.length) throw oasError("invalid-package-manifest", `package ${m.package} manifest has unknown keys: ${unknown.join(", ")}`);
  if (m.compatibility === undefined) throw oasError("invalid-package-manifest", `package ${m.package} manifest requires "compatibility": { "oas": ">=x.y.z" | "^x.y.z" | "x.y.z" }`);
  if (typeof m.compatibility !== "object" || m.compatibility === null || Array.isArray(m.compatibility) || !m.compatibility.oas) throw oasError("invalid-package-manifest", `package ${m.package} "compatibility" needs { "oas": "<range>" }`);
  {
    const extraCompat = Object.keys(m.compatibility).filter((k) => k !== "oas");
    if (extraCompat.length) throw oasError("invalid-package-manifest", `package ${m.package} "compatibility" has unknown keys: ${extraCompat.join(", ")}`);
  }
  // Schema/runtime parity: oas must be a STRING matching the grammar — no coercion.
  if (typeof m.compatibility.oas !== "string" || !/^(>=|\^)?\d+\.\d+\.\d+$/.test(m.compatibility.oas)) throw oasError("invalid-package-manifest", `package ${m.package} compatibility.oas ${JSON.stringify(m.compatibility.oas)} is malformed — accepted grammar exactly: >=x.y.z, ^x.y.z, or x.y.z (string)`);
  const root = realpathSync(pdir);
  const inside = (rel, kind) => {
    const r = String(rel);
    if (isAbsolute(r) || r.split(/[\\/]/).includes("..")) throw oasError("path-escape", `package ${m.package} ${kind} path escapes the package root: ${r}`);
    const p = join(pdir, r);
    if (!existsSync(p)) throw oasError("invalid-package-manifest", `package ${m.package} declares a missing ${kind} path: ${r}`);
    const fromRoot = relative(root, realpathSync(p));
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw oasError("path-escape", `package ${m.package} ${kind} path resolves outside the package root after symlink resolution: ${r}`);
    return p;
  };
  // Template spelling: `configTemplates` is canonical, `configs` is the
  // deprecated read-only alias. Both normalize to one descriptor shape;
  // `_legacySpelling` is diagnostic only.
  if (m.configs !== undefined && m.configTemplates !== undefined) throw oasError("invalid-package-manifest", `package ${m.package} declares both "configTemplates" and the deprecated "configs" spelling — use "configTemplates" only`);
  const legacySpelling = m.configs !== undefined;
  // "." capability roots are READ COMPATIBILITY for already-published packages,
  // and the discriminator is `configTemplates` — NOT `configs`. Published
  // packages exist with a "." root and no template map at all (oas.authoring@1.0.0
  // is capabilities:["."] with neither spelling), so keying acceptance on the
  // deprecated spelling would strand a package the kernel must keep reading.
  // A manifest carrying `configTemplates` is unambiguously new.
  const newFormat = m.configTemplates !== undefined;
  const caps = [];
  const seen = new Map();
  // Packages materialize capabilities: a package with none has nothing to
  // install, so config-only and empty packages are rejected (Decision:
  // "Packages must export at least one capability").
  if (!Array.isArray(m.capabilities) || m.capabilities.some((c) => typeof c !== "string")) throw oasError("invalid-package-manifest", `package ${m.package} "capabilities" must be an array of package-relative capability directories`);
  if (!m.capabilities.length) throw oasError("invalid-package-manifest", `package ${m.package} exports no capabilities — every package must export at least one (config-only and empty packages are rejected)`);
  // Flat single-capability packages: "." means the package root IS the capability
  // dir — it cannot be combined with other capability paths (nesting).
  if (m.capabilities.includes(".") && m.capabilities.length > 1) throw oasError("invalid-package-manifest", `package ${m.package} lists "." (flat single-capability layout) together with other capability paths — "." must be the only entry`);
  if (m.capabilities.includes(".") && newFormat) throw oasError("invalid-package-manifest", `package ${m.package} declares the package root "." as a capability root — packages that ship "configTemplates" are new-format and must use dedicated capability roots such as "capabilities/<slug>" so the installed artifact is self-contained ("." is read compatibility for already-published manifests only, and authoring never emits it)`);
  for (const rel of m.capabilities) {
    const dir = inside(rel, "capability");
    if (!existsSync(join(dir, "oas.json"))) throw oasError("invalid-package-manifest", `package ${m.package} capability path ${rel} has no oas.json (not a capability)`);
    const cm = loadManifestAt(dir, `package:${m.package}`);
    // A PACKAGE-exported id will be materialized as a directory name under
    // installed/, so it must satisfy the materialized grammar — stricter than
    // the legacy standalone-capability rule loadManifestAt applies, which still
    // governs v1/owned/path artifacts named by basename().
    if (!isMaterializedCapabilityId(cm.capability)) throw oasError("invalid-package-manifest", `package ${m.package} exports an unusable capability identity from ${rel}: ${capabilityIdViolation(cm.capability)}`);
    const retiredReason = retiredCapabilityReason(cm.capability);
    if (retiredReason) throw oasError("retired-capability", `package ${m.package} exports retired capability "${cm.capability}" — ${retiredReason}`);
    if (seen.has(cm.capability)) throw oasError("duplicate-capability-id", `package ${m.package} exports capability "${cm.capability}" from both ${seen.get(cm.capability)} and ${rel}`, [seen.get(cm.capability), rel]);
    seen.set(cm.capability, rel);
    caps.push({ id: cm.capability, rel, dir, manifest: cm });
  }
  // Config TEMPLATES (canonical `configTemplates`, deprecated alias `configs`).
  // They are package SOURCE MATERIAL: validated here so acquisition can report
  // and the config lane can adopt them, but installation applies none of them.
  const templateKey = legacySpelling ? "configs" : "configTemplates";
  const rawTemplates = legacySpelling ? m.configs : m.configTemplates;
  if (rawTemplates !== undefined && (rawTemplates === null || typeof rawTemplates !== "object" || Array.isArray(rawTemplates))) throw oasError("invalid-package-manifest", `package ${m.package} "${templateKey}" must be a map of template name → { path, description?, default? }`);
  let defaults = 0;
  const configTemplates = {};
  const TEMPLATE_KEYS = new Set(["path", "description", "default"]);
  for (const [name, tpl] of Object.entries(rawTemplates || {})) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw oasError("invalid-package-manifest", `package ${m.package} config template name "${name}" is invalid`);
    if (!tpl || typeof tpl !== "object" || Array.isArray(tpl) || typeof tpl.path !== "string" || !tpl.path) throw oasError("invalid-package-manifest", `package ${m.package} config template "${name}" needs a string path`);
    const extraTpl = Object.keys(tpl).filter((k) => !TEMPLATE_KEYS.has(k));
    if (extraTpl.length) throw oasError("invalid-package-manifest", `package ${m.package} config template "${name}" has unknown keys: ${extraTpl.join(", ")}`);
    if (tpl.description !== undefined && typeof tpl.description !== "string") throw oasError("invalid-package-manifest", `package ${m.package} config template "${name}" description must be a string`);
    if (tpl.default !== undefined && typeof tpl.default !== "boolean") throw oasError("invalid-package-manifest", `package ${m.package} config template "${name}" default must be a boolean`);
    const p = inside(tpl.path, `config template "${name}"`);
    if (!lstatSync(p).isFile()) throw oasError("invalid-package-manifest", `package ${m.package} config template "${name}" path is not a file: ${tpl.path}`);
    if (tpl.default) defaults++;
    configTemplates[name] = { path: tpl.path, ...(tpl.description !== undefined ? { description: tpl.description } : {}), default: tpl.default === true };
  }
  if (defaults > 1) throw oasError("invalid-package-manifest", `package ${m.package} marks ${defaults} config templates as default (at most one)`);
  if (m.dependencies !== undefined && (!Array.isArray(m.dependencies) || m.dependencies.some((d) => typeof d !== "string"))) throw oasError("invalid-package-manifest", `package ${m.package} "dependencies" must be an array of package source specs`);
  if (m.dependencies && new Set(m.dependencies).size !== m.dependencies.length) throw oasError("invalid-package-manifest", `package ${m.package} "dependencies" contains duplicates`);
  if (new Set(m.capabilities).size !== m.capabilities.length) throw oasError("invalid-package-manifest", `package ${m.package} "capabilities" contains duplicates`);
  return { ...m, _dir: pdir, _capabilities: caps, _legacySpelling: legacySpelling, _configTemplates: configTemplates };
}

/** Assert one capability root can be MATERIALIZED as a self-contained artifact
 * (contract §2.5): every resource the capability declares must exist and must
 * realpath-resolve inside its OWN root. This is the boundary that makes an
 * installed directory independently hashable, inspectable, restorable and
 * trustable — a capability reaching package-only paths, a sibling capability, or
 * outside the package cannot be projected and is rejected rather than installed
 * broken.
 *
 * `capDir` is the STAGED capability root; `manifest` its loaded oas.json. */
export function assertCapabilitySelfContained(capDir, manifest) {
  const root = realpathSync(capDir);
  const id = manifest.capability;
  const escapes = (real) => {
    const fromRoot = relative(root, real);
    return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  };
  const resolveDeclared = (rel, kind) => {
    const r = String(rel);
    if (isAbsolute(r) || r.split(/[\\/]/).includes("..")) throw oasError("path-escape", `capability ${id} ${kind} path leaves its capability root: ${r}`);
    const p = join(capDir, r);
    if (!existsSync(p)) throw oasError("capability-not-self-contained", `capability ${id} declares a ${kind} that does not exist inside its capability root: ${r} — a materialized capability must carry every artifact it declares`);
    const real = realpathSync(p);
    if (escapes(real)) throw oasError("capability-not-self-contained", `capability ${id} ${kind} "${r}" resolves outside its capability root after symlink resolution (${real}) — it cannot be materialized as a self-contained artifact`);
    return { path: p, real };
  };
  // Directory resources are walked: a descendant symlink may escape even when
  // the declared root itself does not (visited set keeps contained link cycles
  // from looping).
  const visited = new Set();
  const walkContained = (dir, kind, declared) => {
    const realDir = realpathSync(dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      let real;
      try { real = realpathSync(p); }
      catch { throw oasError("capability-not-self-contained", `capability ${id} ${kind} "${declared}" contains a broken symlink: ${relative(capDir, p)}`); }
      if (escapes(real)) throw oasError("capability-not-self-contained", `capability ${id} ${kind} "${declared}" contains a path escaping its capability root: ${relative(capDir, p)} → ${real}`);
      if (e.isSymbolicLink()) { if (lstatSync(real).isDirectory()) walkContained(real, kind, declared); }
      else if (e.isDirectory()) walkContained(p, kind, declared);
    }
  };
  for (const declared of manifest.skills || []) {
    const { path, real } = resolveDeclared(declared, "skill tree");
    if (statSync(real).isDirectory()) walkContained(path, "skill tree", declared);
  }
  for (const declared of manifest.agents || []) {
    const { path, real } = resolveDeclared(declared, "capability-defined agent");
    if (!statSync(real).isDirectory()) throw oasError("capability-not-self-contained", `capability ${id} capability-defined agent "${declared}" is not a directory`);
    walkContained(path, "capability-defined agent", declared);
  }
  if (manifest.inject) resolveDeclared(manifest.inject, "injection");
  // Executable declarations are "<script> [args...]": only the script token is a
  // path. Arguments are opaque to containment.
  for (const [name, value] of Object.entries(manifest.commands || {})) {
    const script = String(value).trim().split(/\s+/)[0];
    if (script) resolveDeclared(script, `command "${name}"`);
  }
  for (const [event, value] of Object.entries(manifest.hooks || {})) {
    const decl = hookDeclaration(value);
    const script = decl ? decl.command.trim().split(/\s+/)[0] : "";
    if (script) resolveDeclared(script, `${event} hook`);
  }
}

const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const LOCKFILE_VERSION = 2;
/** Package rows lock the TRANSPORT unit only: no capability list (the capability
 * rows' `package` back-reference is the single provider truth) and no trust
 * (trust binds to materialized capability artifacts). */
const LOCK_PACKAGE_KEYS = new Set(["source", "path", "version", "commit", "integrity", "dependencies"]);
/** Capability rows lock the MATERIALIZED entity. */
const LOCK_CAPABILITY_KEYS = new Set(["version", "package", "path", "integrity", "trusted"]);
/** Own-property PRESENCE of any of these on a package row is forbidden
 * transitional evidence (contract §4.1) — never truthiness and never array
 * length, so an empty `capabilities: []` or a dependency-free old row still
 * classifies. Package-row `path`/`dependencies` are NEVER tells: the current
 * shape retains both. */
const TRANSITIONAL_ROW_FIELDS = ["capabilities", "trustedCapabilities", "depsIntegrity"];

/** A null-prototype copy of a raw parsed JSON map. Raw objects return inherited
 * `constructor`/`toString`/`valueOf` for `map[id]` even with no own entry, so
 * every ID-keyed map in the engine goes through this (or `Object.hasOwn`) before
 * any lookup, membership check or graph walk. */
function nullProtoMap(raw) {
  const out = Object.create(null);
  for (const k of Object.keys(raw || {})) out[k] = raw[k];
  return out;
}

/** ONE strict lock parser for v1 and the capability-materialization v2: reads +
 * validates root shape, lockfile version, map shapes and keys, entry shapes
 * (full semantic pass incl. the dependency graph and the capability→package
 * back-references), and the v1 capability map. EVERY violation is a typed
 * invalid-lock with provenance, raised with NO side effects. Old locks are read
 * AS THEY ARE — never normalized, repaired or rewritten (the single exception is
 * the state-free empty transitional document, §4.1). Returns
 * { version, packages, capabilities, legacyCapabilities } (null-prototype and
 * validated) or null when the file does not exist. */
export function parseLockFileStrict(file) {
  if (!existsSync(file)) return null;
  const bad = (msg, extra = {}) => oasError("invalid-lock", `${file}: ${msg}`, [{ file, violation: msg, ...extra }]);
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { throw bad(`malformed JSON — ${e.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw bad(`lock root must be a JSON object (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`);
  const v = parsed.lockfileVersion;
  if (v !== undefined && typeof v !== "number") throw bad(`lockfileVersion must be a number (got ${JSON.stringify(v)})`);
  if (v !== undefined && v !== 1 && v !== 2) throw bad(`unsupported lockfileVersion ${v}`);
  const version = v ?? 1;
  if (parsed.capabilities !== undefined && (parsed.capabilities === null || typeof parsed.capabilities !== "object" || Array.isArray(parsed.capabilities))) {
    throw bad(`"capabilities" must be an object map (got ${parsed.capabilities === null ? "null" : Array.isArray(parsed.capabilities) ? "array" : typeof parsed.capabilities})`);
  }
  const out = { version, packages: Object.create(null), capabilities: Object.create(null), legacyCapabilities: Object.create(null) };
  if (version === 1) {
    if (parsed.packages !== undefined) throw bad(`lockfileVersion 1 must not carry a "packages" map`);
    // Validate the COMPLETE v1 map before ANY consumer sees it. Retirement
    // intentionally wins over shape validation (the user is told to delete that
    // entry), but every non-retired entry is strict — that keeps restore
    // preflight atomic and stops a malformed entry from granting the
    // marketplace/hoisted exemption during discovery (reviewer-12e2d86).
    for (const id of Object.keys(parsed.capabilities || {})) {
      const entry = parsed.capabilities[id];
      if (!retiredCapabilityReason(id)) {
        const violation = legacyCapabilityEntryViolation(entry);
        if (violation) throw bad(`legacy entry "${id}" is malformed (${violation})`, { package: id });
      }
      out.legacyCapabilities[id] = entry;
    }
    return out;
  }
  const rawPackages = parsed.packages;
  if (rawPackages === undefined || rawPackages === null || typeof rawPackages !== "object" || Array.isArray(rawPackages)) {
    throw bad(`lockfileVersion 2 requires a "packages" object map (got ${rawPackages === undefined ? "undefined" : rawPackages === null ? "null" : Array.isArray(rawPackages) ? "array" : typeof rawPackages})`);
  }
  const packageKeys = Object.keys(rawPackages);
  const hasCapabilityMap = Object.hasOwn(parsed, "capabilities");
  const stateFree = !packageKeys.length && (!hasCapabilityMap || !Object.keys(parsed.capabilities).length);
  // UNSUPPORTED TRANSITIONAL v2 (contract §4.1) — an exact OR predicate, decided
  // centrally before any discovery or mutation. It is never converted and never
  // partially interpreted; the operator recreates the scope.
  const unsupported = (why) => bad(`unsupported transitional package-root lockfileVersion 2 (${why}). This is the superseded package-store lock shape; it is not converted or interpreted. Delete this lock (and any .agents/packages directory) and recreate the scope's state with \`oas install\`.`);
  if (!stateFree) {
    if (!hasCapabilityMap) throw unsupported(`no top-level "capabilities" map`);
    for (const id of packageKeys) {
      const row = rawPackages[id];
      if (!row || typeof row !== "object" || Array.isArray(row)) continue; // shape error reported below
      const tells = TRANSITIONAL_ROW_FIELDS.filter((f) => Object.hasOwn(row, f));
      if (tells.length) throw unsupported(`package row "${id}" carries ${tells.join(", ")}`);
    }
  }
  for (const id of packageKeys) {
    if (!PACKAGE_ID_RE.test(id)) throw bad(`packages map has an invalid package key ${JSON.stringify(id)}`, { package: id });
    const e = rawPackages[id];
    if (!e || typeof e !== "object" || Array.isArray(e)) throw bad(`lock entry for "${id}" is not an object`, { package: id });
    const extra = Object.keys(e).filter((k) => !LOCK_PACKAGE_KEYS.has(k));
    if (extra.length) throw bad(`lock entry for "${id}" has unknown keys: ${extra.join(", ")}`, { package: id });
    out.packages[id] = e;
  }
  for (const id of Object.keys(out.packages)) validateLockEntry(id, out.packages[id], out.packages, { file });
  // A state-free empty transitional document carries nothing, so it reads as the
  // canonical empty lock rather than failing (contract §4.1).
  if (hasCapabilityMap) {
    for (const id of Object.keys(parsed.capabilities)) {
      // BEFORE any filesystem join anywhere downstream: a revised-v2 capability
      // key names a directory under installed/, so the grammar is enforced here,
      // in the one central reader, rather than at each consumer.
      if (!isMaterializedCapabilityId(id)) throw bad(`capabilities map has an invalid capability key: ${capabilityIdViolation(id)}`);
      const e = parsed.capabilities[id];
      if (!e || typeof e !== "object" || Array.isArray(e)) throw bad(`capability lock entry for "${id}" is not an object`, { package: id });
      const extra = Object.keys(e).filter((k) => !LOCK_CAPABILITY_KEYS.has(k));
      if (extra.length) throw bad(`capability lock entry for "${id}" has unknown keys: ${extra.join(", ")}`, { package: id });
      out.capabilities[id] = e;
    }
  }
  for (const id of Object.keys(out.capabilities)) validateCapabilityLockEntry(id, out.capabilities[id], out.packages, { file });
  return out;
}

/** Every lock-owning scope visible from a directory, outermost → innermost.
 * Uses DIRECT raw lock-scope reads (every ancestor carrying an oas-lock.json)
 * merged with the config-chain levels, so a lock-only scope with no config is
 * still visible to central reading, discovery and unsupported-shape rejection. */
function lockLevels(startDir) {
  const levels = [];
  for (let d = resolve(startDir); ; d = dirname(d)) {
    if (existsSync(join(d, OAS_LOCK_FILE))) levels.push(d);
    if (dirname(d) === d) break;
  }
  for (const cfg of configChain(startDir)) if (existsSync(join(cfg._level, OAS_LOCK_FILE)) && !levels.includes(cfg._level)) levels.push(cfg._level);
  return levels.reverse();
}

/** THE reader for every supported lock format (contract §5.2). Merges the
 * visible chain, closest scope wins per identity, and FAILS CLOSED: malformed
 * JSON, invalid map keys, semantically invalid entries, and the unsupported
 * transitional v2 shape all RAISE invalid-lock — consumers must not treat a bad
 * lock as absent or usable. Doctor is the only consumer that catches the typed
 * error, and it never uses the invalid data. Every returned map is
 * null-prototype with identity-validated keys, so raw-JSON
 * __proto__/constructor keys cannot forge or impersonate entries.
 *
 * @returns {{ packages, capabilities, legacy, migration }}
 *   legacy     v1 files (including empty ones), untouched.
 *   migration  PURE PROVENANCE: which scopes still need an explicit conversion
 *              and what they hold. Reading never converts anything. */
export function readPackageLocks(startDir) {
  const out = { packages: Object.create(null), capabilities: Object.create(null), levels: [], legacy: [], migration: [] };
  for (const level of lockLevels(startDir)) {
    const file = join(level, OAS_LOCK_FILE);
    const strict = parseLockFileStrict(file); // ONE strict parser — typed invalid-lock on any violation
    if (!strict) continue;
    // The MERGED maps resolve each identity independently, closest scope wins.
    // That is right for "which capability is active here" and wrong for "which
    // package provides it": two scopes can lock the same package id at
    // different versions exporting DISJOINT capabilities, and the merged
    // package row would then belong to a scope that never exported the
    // capability asking for it. Keep the per-level view so provenance can be
    // resolved where it was actually recorded (see providerPackageRow).
    out.levels.push({ level, file, packages: strict.packages, capabilities: strict.capabilities });
    for (const id of Object.keys(strict.packages)) out.packages[id] = { ...strict.packages[id], _file: file, _level: level };
    for (const id of Object.keys(strict.capabilities)) out.capabilities[id] = { ...strict.capabilities[id], _file: file, _level: level };
    if (strict.version !== 1) continue;
    // Empty v1 locks SURFACE (maintainer ruling): every discovered
    // lockfileVersion:1 file appears with provenance — including
    // {capabilities:{}}, which is pending an explicit FORMAT migration and is
    // never converted implicitly.
    const legacyIds = Object.keys(strict.legacyCapabilities);
    out.legacy.push({ file, level, lockfileVersion: 1, capabilities: strict.legacyCapabilities });
    out.migration.push({ file, level, lockfileVersion: 1, kind: legacyIds.length ? "v1" : "v1-empty", capabilities: legacyIds });
  }
  return out;
}

/** The package row that actually PROVIDES a capability row, resolved at the
 * capability's own lock level.
 *
 * Never `locks.packages[row.package]`: that is the closest row for the id,
 * which may come from a different scope. The strict parser already refuses a
 * capability whose provider is absent from the same file's packages map, so
 * this lookup cannot miss for a row that survived reading.
 *
 * @param locks  a readPackageLocks() result
 * @param row    a capability row from `locks.capabilities` (carries _file) */
export function providerPackageRow(locks, row) {
  if (!row) return undefined;
  const own = locks.levels.find((l) => l.file === row._file);
  const pkg = own && Object.hasOwn(own.packages, row.package) ? own.packages[row.package] : undefined;
  return pkg ? { ...pkg, _file: own.file, _level: own.level } : undefined;
}

/** The lock document at ONE scope as a mutable draft. An existing v1 lock —
 * INCLUDING an empty one — is `legacy-lock`: conversion happens only through
 * explicit migration, so only an ABSENT lock is a fresh document. */
function lockDraft(levelDir) {
  const file = join(levelDir, OAS_LOCK_FILE);
  const strict = parseLockFileStrict(file);
  if (strict && strict.version !== LOCKFILE_VERSION) {
    throw oasError("legacy-lock", `${file} is lockfileVersion ${strict.version} — run \`oas migrate --dir ${levelDir}\` to convert this scope before locking capabilities`, [{ file, lockfileVersion: strict.version }]);
  }
  return { file, doc: strict ? { packages: nullProtoMap(strict.packages), capabilities: nullProtoMap(strict.capabilities) } : { packages: Object.create(null), capabilities: Object.create(null) } };
}

/** Validate a COMPLETE prospective document, then write it atomically. An
 * invalid lock must never be produced by a writer (maintainer finding 3). */
function writeLockDocument(file, doc) {
  const packages = Object.create(null);
  for (const id of Object.keys(doc.packages)) {
    if (!PACKAGE_ID_RE.test(id)) throw oasError("invalid-lock", `${file} packages map has an invalid package key ${JSON.stringify(id)}`, [{ file, package: id }]);
    packages[id] = doc.packages[id];
  }
  for (const id of Object.keys(packages)) validateLockEntry(id, packages[id], packages, { file });
  for (const id of Object.keys(doc.capabilities)) validateCapabilityLockEntry(id, doc.capabilities[id], packages, { file });
  // Sorted keys keep the serialization deterministic across runs and platforms.
  const sorted = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
  atomicWriteFileSync(file, JSON.stringify({ lockfileVersion: LOCKFILE_VERSION, packages: sorted(doc.packages), capabilities: sorted(doc.capabilities) }, null, 2) + "\n");
  return file;
}

/** Write/replace (entry) or delete (entry === null) one PACKAGE row. */
export function writePackageLock(levelDir, packageId, entry) {
  const { file, doc } = lockDraft(levelDir);
  if (typeof packageId !== "string" || !PACKAGE_ID_RE.test(packageId)) throw oasError("invalid-lock", `invalid package identity ${JSON.stringify(packageId)} (must be a string matching the package-id grammar)`);
  if (entry === null) delete doc.packages[packageId];
  else doc.packages[packageId] = entry;
  return writeLockDocument(file, doc);
}

/** Write/replace (entry) or delete (entry === null) one CAPABILITY row. */
export function writeCapabilityLockEntry(levelDir, capabilityId, entry) {
  const { file, doc } = lockDraft(levelDir);
  if (typeof capabilityId !== "string" || !capabilityId) throw oasError("invalid-lock", `invalid capability identity ${JSON.stringify(capabilityId)}`);
  if (entry === null) delete doc.capabilities[capabilityId];
  else doc.capabilities[capabilityId] = entry;
  return writeLockDocument(file, doc);
}

/** Replace many rows at one scope in ONE validated write — the acquire / update /
 * remove / migrate commit step. `packages` and `capabilities` are maps of
 * id → entry (or null to delete). `replacePackages` names packages whose ENTIRE
 * export set is being rewritten, so capability rows they used to supply and no
 * longer do are dropped in the same transaction instead of dangling. */
function writeLockEntries(levelDir, { packages = {}, capabilities = {}, replacePackages = [] } = {}) {
  const { file, doc } = lockDraft(levelDir);
  for (const pid of replacePackages) {
    for (const [cid, row] of Object.entries(doc.capabilities)) if (row.package === pid) delete doc.capabilities[cid];
  }
  for (const [id, entry] of Object.entries(packages)) {
    if (!PACKAGE_ID_RE.test(id)) throw oasError("invalid-lock", `invalid package identity ${JSON.stringify(id)}`);
    if (entry === null) delete doc.packages[id]; else doc.packages[id] = entry;
  }
  for (const [id, entry] of Object.entries(capabilities)) {
    if (entry === null) delete doc.capabilities[id]; else doc.capabilities[id] = entry;
  }
  return writeLockDocument(file, doc);
}

/** Materialize a package's checked-in JS runtime deps with `npm ci --ignore-scripts`
 * ONLY (no lifecycle scripts ever run at acquisition). Materialization roots are
 * the package root AND each declared capability dir that carries BOTH
 * package.json and package-lock.json (per-capability locks let inner oas.json
 * resources resolve node_modules/... beside the capability manifest while
 * staying inside the package containment boundary). Best-effort: returns a report. */
/** Platform-variance detection for a checked-in npm lockfile (v1 MUST:
 * platform-invariant closures — runtime API addendum §2; maintainer ruling on
 * 19fbc86). Scope: ONLY entries belonging to the materialized non-dev/non-peer
 * closure — omitted metadata cannot fail an otherwise valid closure. For
 * INCLUDED entries, reject: os/cpu/libc markers, optional/optionalDependencies
 * variance, and install scripts (an included install script is disallowed
 * even though --ignore-scripts inerts it: the package's runtime almost
 * certainly expects the artifacts the script would have built). Lockfile
 * current packages maps only; v1 fails closed. */
export function platformVariantLockPackages(lockFile) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(lockFile, "utf8")); }
  catch { return []; /* malformed npm lock — npm ci itself fails closed */ }
  if (!parsed || typeof parsed !== "object") return [];
  if (!parsed.packages || typeof parsed.packages !== "object") {
    // lockfileVersion 1 (or unknown shape): nested dependency graphs bypass a
    // packages-map walk — fail closed rather than under-scan.
    return [`(lockfile) unsupported npm lockfileVersion ${parsed.lockfileVersion ?? "1"} — regenerate with a modern npm (lockfileVersion ≥ 2) so the platform-invariance scan can verify the production closure`];
  }
  const out = [];
  for (const [path, e] of Object.entries(parsed.packages || {})) {
    if (!path || !e || typeof e !== "object") continue;
    // Outside the materialized production tree — the omit set never installs
    // TRUE dev-only and peer-only entries. devOptional (dev dep AND optional
    // dep of a non-dev dep) IS installed by --omit=dev --omit=peer, so it
    // stays in scope (reviewer-b875620, repro'd with npm 10.9.4).
    if (e.dev || e.peer) continue;
    if (Array.isArray(e.os) || Array.isArray(e.cpu) || e.libc) out.push(`${path} (os/cpu/libc constraint)`);
    else if (e.optional) out.push(`${path} (optional dependency — install-time variance)`);
    else if (e.hasInstallScript) out.push(`${path} (install script — runtime likely expects built artifacts that --ignore-scripts suppresses)`);
  }
  return out;
}

/** Post-materialization native-binary scan (maintainer ruling item 3): any
 * .node binary inside a materialized node_modules tree is platform-variant by
 * definition. Run beside symlink containment, before digest/swap. */
export function assertNoNativeBinaries(root) {
  const visited = new Set();
  const walk = (d, inDeps) => {
    let realD;
    try { realD = realpathSync(d); } catch { return; }
    if (inDeps) {
      if (visited.has(realD)) return;
      visited.add(realD);
    }
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const nowIn = inDeps || e.name === "node_modules";
      if (e.isSymbolicLink()) {
        // Follow dependency-context links (containment has already verified
        // they resolve inside the root); the target's files count as deps.
        if (!nowIn) continue;
        let target; let isDir = false;
        try { target = realpathSync(p); isDir = lstatSync(target).isDirectory(); } catch { continue; }
        if (isDir) walk(target, true);
        else if (nowIn && target.endsWith(".node")) throw oasError("invalid-package-manifest", `materialized runtime closure contains a native binary: ${relative(root, p)} — v1 requires platform-invariant closures (vendor a pure-JS dependency or drop it)`);
      } else if (e.isDirectory()) walk(p, nowIn);
      else if (nowIn && e.isFile() && e.name.endsWith(".node")) {
        throw oasError("invalid-package-manifest", `materialized runtime closure contains a native binary: ${relative(root, p)} — v1 requires platform-invariant closures (vendor a pure-JS dependency or drop it)`);
      }
    }
  };
  walk(root, false);
}

/** Materialize ONE materialization root's checked-in JS runtime deps with
 * `npm ci --ignore-scripts` only — no npm lifecycle script ever runs, at any
 * phase. In the materialized model the roots are the declared CAPABILITY roots
 * (addendum §2): the resulting node_modules becomes part of that capability's
 * artifact, which is what lets an inner oas.json resolve `node_modules/...`
 * relative to its own manifest inside a self-contained installation. A root
 * without both package.json and package-lock.json has no closure and is a
 * successful no-op. Best-effort: returns a report rather than throwing. */
export function materializeCapabilityDeps(root) {
  if (!existsSync(join(root, "package-lock.json")) || !existsSync(join(root, "package.json"))) return { materialized: false, root, empty: true };
  const variant = platformVariantLockPackages(join(root, "package-lock.json"));
  if (variant.length) return { materialized: false, root, error: `platform-variant runtime closure in ${root}: ${variant.join(", ")} — v1 requires platform-invariant closures (vendor a pure-JS dependency or drop it)` };
  try {
    // Maintainer ruling: production tree only — dev AND host peer deps omitted;
    // packages reach host peer APIs only through the supported host boundary.
    execFileSync("npm", ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "ignore", timeout: 300000 });
  } catch (e) {
    return { materialized: false, root, error: `npm ci --ignore-scripts failed in ${root}: ${e.message}` };
  }
  return { materialized: true, root };
}

/** Platform-invariance preflight over a set of materialization roots, run
 * TRANSACTION-WIDE before any `npm ci` (reviewer-11752b2), so a clean closure
 * can never materialize ahead of a rejected sibling — and so a kept/no-op path,
 * which skips materialization entirely, still cannot carry a prohibited
 * pre-existing closure. */
export function assertPlatformInvariantLocks(roots) {
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (!existsSync(join(root, "package-lock.json")) || !existsSync(join(root, "package.json"))) continue;
    const variant = platformVariantLockPackages(join(root, "package-lock.json"));
    if (variant.length) throw oasError("invalid-package-manifest", `platform-variant runtime closure in ${root}: ${variant.join(", ")} — v1 requires platform-invariant closures (vendor a pure-JS dependency or drop it)`);
  }
}

/** Symlink containment for materialized dependency trees (maintainer finding 4):
 * every symlink under every node_modules below `root` must realpath-resolve
 * INSIDE `root` — the CAPABILITY artifact root in the materialized model, since
 * that is the boundary the artifact must be self-contained within. Broken or
 * escaping links throw path-escape. Node import resolution follows symlinks, so
 * this check is global, not best-effort. Run after npm ci and BEFORE any
 * digest/swap. */
export function assertMaterializedDepsContained(root) {
  const real = realpathSync(root);
  const visited = new Set(); // realpath dirs visited WITH dependency context
  const walk = (d, inDeps) => {
    let realD;
    try { realD = realpathSync(d); } catch { return; }
    if (inDeps) {
      if (visited.has(realD)) return;
      visited.add(realD);
    }
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const nowIn = inDeps || e.name === "node_modules";
      if (e.isSymbolicLink()) {
        if (!nowIn) continue; // source-tree symlinks are covered by manifest/skill containment
        let target;
        try { target = realpathSync(p); }
        catch { throw oasError("path-escape", `materialized dependency symlink is broken: ${relative(root, p)}`); }
        const fromRoot = relative(real, target);
        if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
          throw oasError("path-escape", `materialized dependency symlink escapes the package root: ${relative(root, p)} → ${target}`);
        }
        // RECURSE through contained link targets PRESERVING dependency context:
        // the lexical walk visits the target with inDeps=false, so nested
        // symlinks reachable AS DEPENDENCY PATHS (node_modules/dep →
        // ../vendor/dep containing an escaping link) must be checked here.
        // NOTE: the try/catch guards ONLY the lstat probe — an escape thrown
        // inside the recursive walk must propagate, never be swallowed.
        let isDir = false;
        try { isDir = lstatSync(target).isDirectory(); } catch { /* file/broken target already handled */ }
        if (isDir) walk(target, true);
      } else if (e.isDirectory()) walk(p, nowIn);
    }
  };
  walk(root, false);
}

/** Check out the exact commit a caller-supplied ref names, and return it.
 *
 * A ref is a PUBLIC value — it arrives from a CLI spec, a lock entry, or a
 * REMOTE package manifest's `dependencies[]` — so it must never reach git as
 * an option-capable argument. `git checkout -q --detach` (i.e. a ref spelled
 * `--detach`) exits 0 without selecting any revision, after which a caller
 * that reads HEAD reports whatever was already checked out AS the pinned
 * commit: a silent fail-open on the exact pin this function exists to enforce.
 *
 * So: resolve behind `--end-of-options` first, require a 40-hex commit, check
 * THAT out (a hex string cannot be an option), and verify HEAD landed on it. */
export function gitCheckoutExactRef(dir, ref, spec) {
  const resolve1 = (rev) => {
    try { return execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "--end-of-options", rev], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { return ""; }
  };
  // Direct resolution first, preserving git's own precedence (exact SHA, tag,
  // local branch). Then the remote-tracking fallback: a plain clone materializes
  // only the default branch locally, so `<ref>` for any OTHER branch exists
  // solely as refs/remotes/origin/<ref>. `git checkout <ref>` used to reach it
  // by DWIM guessing — which is exactly what we gave up by checking out a
  // resolved hash, so it has to be resolved explicitly instead (still behind
  // --end-of-options, and the "refs/" prefix cannot start with a dash).
  const sha = resolve1(`${ref}^{commit}`) || resolve1(`refs/remotes/origin/${ref}^{commit}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw oasError("invalid-source", `git ref ${JSON.stringify(String(ref))} does not resolve to a commit in ${spec}`);
  execFileSync("git", ["-C", dir, "checkout", "-q", "--detach", sha], { stdio: "pipe" });
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== sha) throw oasError("invalid-source", `git checkout of ${sha} in ${spec} left HEAD at ${head}`);
  return sha;
}

/** Resolve a configured package path inside a fetched checkout to the directory
 * it selects, WITHOUT requiring a manifest there. Returns undefined when the
 * path names nothing (or a non-directory) in this checkout — the caller decides
 * whether that is a diagnosis (inspection) or a failure (acquisition).
 *
 * Containment is decided on the REALPATH: a symlinked payload root is followed,
 * but a link (at any depth of the configured path) whose target lands outside
 * the checkout is path-escape, and so is a broken link. Lexical checks alone
 * cannot see either. */
function resolvePackagePayloadDir(checkout, packagePath, spec) {
  const base = realpathSync(checkout);
  const escapes = (real) => {
    const fromRoot = relative(base, real);
    return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  };
  // Walk COMPONENT BY COMPONENT. A single lstat of the full path cannot tell a
  // genuinely absent path from one whose intermediate link is broken —
  // "dangling/sub" makes both existsSync and lstat fail — so a broken or
  // escaping link at any depth would be misreported as "no package here".
  const segments = packagePath === "." ? [] : packagePath.split("/");
  let current = checkout;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    const traversed = segments.slice(0, i + 1).join("/");
    let st;
    try { st = lstatSync(current); }
    catch { return undefined; } // genuinely absent at this depth
    if (!st.isSymbolicLink()) continue;
    let real;
    try { real = realpathSync(current); }
    catch { throw oasError("path-escape", `package path "${packagePath}" in ${spec} traverses a broken symlink at "${traversed}"`); }
    if (escapes(real)) throw oasError("path-escape", `package path "${packagePath}" in ${spec} leaves the fetched source root at "${traversed}" after symlink resolution: ${real}`);
  }
  const real = realpathSync(current);
  if (escapes(real)) throw oasError("path-escape", `package path "${packagePath}" in ${spec} resolves outside the fetched source root after symlink resolution: ${real}`);
  return statSync(real).isDirectory() ? real : undefined;
}

/** Resolve the package root inside a fetched source (contract §1.1): the
 * configured path must exist, be a directory contained in the checkout after
 * symlink resolution, and carry oas-package.json there. Exported so every
 * consumer that fetches a source itself (WS2 profile diff) selects the package
 * root exactly the way acquisition does. */
export function resolvePackageRoot(checkout, packagePath, spec) {
  const dir = resolvePackagePayloadDir(checkout, packagePath, spec);
  if (!dir) throw oasError("invalid-source", `package path "${packagePath}" is not a directory in ${spec}${packagePath === DEFAULT_PACKAGE_PATH ? ` — the default package path; select another with "#<path>" (or "#." for the repository root)` : ""}`);
  if (!existsSync(join(dir, "oas-package.json"))) throw oasError("invalid-package-manifest", `${spec} has no oas-package.json at package path "${packagePath}"${packagePath === DEFAULT_PACKAGE_PATH ? ` (the default package path) — select another with "#<path>" (or "#." for the repository root)` : ""}`);
  return dir;
}

/** Fetch ONE exact commit of a source once and materialize ONLY the selected
 * contained package root at `dest` (contract §5). `opts.path` overrides the
 * spec's and the catalog's selection — restore passes the LOCKED path so an
 * upstream/catalog path move can never change what a bare restore installs.
 * Returns the resolved commit and the normalized path that was installed. */
function fetchPackageSource(parsed, dest, catalog, { commit, path: pathOverride } = {}) {
  if (parsed.kind === "catalog") {
    const r = (catalog || defaultCatalogResolve)(parsed.id, parsed.selector);
    if (!r || !r.url) throw oasError("invalid-source", `the official package catalog cannot resolve "${parsed.id}${parsed.selector ? `@${parsed.selector}` : ""}"`);
    const entryPath = normalizePackagePath(r.path, { where: `package path in the official catalog entry for "${parsed.id}"` });
    const path = pathOverride ?? entryPath ?? DEFAULT_PACKAGE_PATH;
    return fetchPackageSource({ kind: "git", url: r.url, ref: r.ref, packagePath: path }, dest, catalog, { commit, path });
  }
  if (parsed.kind === "git") {
    const path = pathOverride ?? parsed.packagePath ?? DEFAULT_PACKAGE_PATH;
    // Clone the whole repository ONCE beside dest, then keep only the selected
    // subtree: everything else (repo docs, CI, owner souls, sibling packages)
    // never becomes installed bytes and never reaches the integrity digest.
    const checkout = `${dest}.checkout`;
    rmSync(checkout, { recursive: true, force: true });
    try {
      execFileSync("git", ["clone", "-q", parsed.url, checkout], { stdio: "pipe" });
      const ref = commit || parsed.ref;
      const head = ref
        ? gitCheckoutExactRef(checkout, ref, parsed.url)
        : execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const payload = resolvePackageRoot(checkout, path, parsed.url);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(payload, dest);
      // Our own clone metadata is never package payload (and packageIntegrity
      // already ignores it) — dropping it keeps installed bytes equal to the
      // selected subtree whether that subtree is the repository root or not.
      rmSync(join(dest, ".git"), { recursive: true, force: true });
      return { commit: head, path };
    } finally { rmSync(checkout, { recursive: true, force: true }); }
  }
  if (pathOverride !== undefined && pathOverride !== ".") {
    throw oasError("invalid-source", `local package sources are exact directories (contract §9); "${parsed.normalized}" cannot select the contained path "${pathOverride}"`);
  }
  if (!existsSync(parsed.path)) throw oasError("invalid-source", `local package path does not exist: ${parsed.path}`);
  if (!existsSync(join(parsed.path, "oas-package.json"))) throw oasError("invalid-package-manifest", `${parsed.path} has no oas-package.json distribution manifest`);
  copyTreeSafe(parsed.path, dest);
  stripArtifactVcsRoot(dest);
  return { commit: "local", path: "." };
}

/** The lock rows at ONE scope (not the merged chain), as null-prototype maps.
 * Raises invalid-lock on any violation; an absent or v1 lock reads as empty. */
function levelLockRows(levelDir) {
  const strict = parseLockFileStrict(join(levelDir, OAS_LOCK_FILE));
  return strict && strict.version === LOCKFILE_VERSION
    ? { packages: strict.packages, capabilities: strict.capabilities }
    : { packages: Object.create(null), capabilities: Object.create(null) };
}

/** Create a transaction staging directory inside the (gitignored) installed
 * store: same filesystem as the destination, so the commit phase is a rename;
 * dot-prefixed, so discovery skips it.
 *
 * Staging has to live inside the store, so on a scope that has no store yet this
 * necessarily creates `.agents/`, `.agents/capabilities/` and
 * `.agents/capabilities/installed/`. A refused or failed acquisition must leave
 * the scope UNTOUCHED, so the exact set of anchor directories this operation
 * had to create is recorded here and handed back for `pruneCreatedAnchors`.
 * Returns them DEEPEST-FIRST, which is also the only safe removal order.
 *
 * @returns {{ dir: string, createdAnchors: string[] }} */
function makeStaging(levelDir) {
  const root = installedCapabilitiesDir(levelDir);
  const capabilitiesDir = dirname(root);
  const anchors = [root, capabilitiesDir, dirname(capabilitiesDir)]; // installed → capabilities → .agents
  const createdAnchors = anchors.filter((d) => !existsSync(d));
  mkdirSync(root, { recursive: true });
  return { dir: mkdtempSync(join(root, STAGING_PREFIX)), createdAnchors };
}

/** Undo the anchor directories `makeStaging` had to create, deepest-first.
 *
 * Only directories THIS operation created are candidates — a pre-existing empty
 * `.agents/` belongs to the scope and is never removed. `rmdirSync` refuses a
 * non-empty directory, which is exactly the "only while empty" rule: it makes
 * owned/, adopted/, config-templates/, an installed artifact, or any unrelated
 * state a hard stop rather than something to reason about. The first failure
 * breaks the loop, because a directory that could not be removed is by
 * definition still holding everything above it.
 *
 * Safe to call unconditionally after a SUCCESSFUL operation too: the store is
 * non-empty then, so every rmdir fails on the first try and nothing happens. */
function pruneCreatedAnchors(createdAnchors) {
  for (const dir of createdAnchors) {
    try { rmdirSync(dir); } catch { break; }
  }
}

/** The generated provenance carried INSIDE every materialized artifact.
 *
 * Because the file is part of the artifact's integrity, a future kernel
 * reprojecting the same locked bytes must produce it byte-for-byte. It therefore
 * contains NOTHING about the writing kernel — only lock-, source- and
 * manifest-derived values — and is serialized deterministically: exactly these
 * keys in this order, two-space JSON, one trailing newline, mode 0644.
 * `schemaVersion` is a constant of the format, bumped only by an explicit
 * contract change (which is itself an integrity change, so it is visible). */
function capabilityInstallationRecord(cap, pkg) {
  return {
    schemaVersion: 1,
    capability: cap.id,
    version: cap.manifest.version,
    package: pkg.package,
    packageVersion: pkg.version,
    source: pkg.source,
    commit: pkg.commit,
    packagePath: pkg.path,
    capabilityPath: cap.rel,
  };
}
function writeCapabilityInstallation(dest, cap, pkg) {
  writeFileSync(join(dest, CAPABILITY_INSTALLATION_FILE), JSON.stringify(capabilityInstallationRecord(cap, pkg), null, 2) + "\n", { mode: 0o644 });
}
/** Read an artifact's provenance and check it AGREES with the lock rows it was
 * projected from. Disagreement is invalid-lock: the artifact and the lock claim
 * different origins, and neither may silently win. (A modified file also fails
 * integrity, but this gives the precise diagnosis.) */
export function verifyCapabilityInstallation(dir, capabilityId, capRow, pkgRow) {
  const file = join(dir, CAPABILITY_INSTALLATION_FILE);
  if (!existsSync(file)) throw oasError("invalid-lock", `materialized capability ${capabilityId} has no ${CAPABILITY_INSTALLATION_FILE} provenance — reproject it with \`oas install\``, [{ package: capabilityId, file }]);
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { throw oasError("invalid-lock", `materialized capability ${capabilityId} has malformed ${CAPABILITY_INSTALLATION_FILE}: ${e.message}`, [{ package: capabilityId, file }]); }
  const expected = {
    schemaVersion: 1, capability: capabilityId, version: capRow.version, package: capRow.package,
    packageVersion: pkgRow.version, source: pkgRow.source, commit: pkgRow.commit,
    packagePath: pkgRow.path, capabilityPath: capRow.path,
  };
  for (const [k, want] of Object.entries(expected)) {
    if (doc?.[k] !== want) throw oasError("invalid-lock", `materialized capability ${capabilityId}: ${CAPABILITY_INSTALLATION_FILE} "${k}" is ${JSON.stringify(doc?.[k])} but the lock records ${JSON.stringify(want)}`, [{ package: capabilityId, file, violation: k }]);
  }
  return doc;
}

/** The executable surface a capability manifest declares. */
function executableSurfaceOf(manifest) {
  return { commands: Object.keys(manifest?.commands || {}), hooks: Object.keys(manifest?.hooks || {}) };
}
function hasExecutableSurface(manifest) {
  const s = executableSurfaceOf(manifest);
  return s.commands.length > 0 || s.hooks.length > 0;
}

/** MATERIALIZE one capability out of a staged package payload into a flat,
 * self-contained artifact (Decision: "Materialized capabilities are
 * self-contained"). Everything happens in staging; nothing durable is touched.
 *
 * Order matters and is load-bearing:
 *   1. materialize the capability's own runtime closure (npm ci, no scripts);
 *   2. verify self-containment of every DECLARED resource, then symlink
 *      containment and the native-binary scan of the materialized closure —
 *      all against the CAPABILITY root, before any digest;
 *   3. move the validated root into the artifacts area;
 *   4. write .oas-installation.json provenance INSIDE the artifact;
 *   5. hash the finished artifact.
 * Hashing last is what makes provenance and closure tamper-evident.
 */
function materializeCapability({ cap, pkg, artifactsDir }) {
  const rep = materializeCapabilityDeps(cap.dir);
  if (rep.error) throw oasError("invalid-package-manifest", `runtime dependency materialization failed for capability "${cap.id}" of package "${pkg.package}": ${rep.error}`);
  assertCapabilitySelfContained(cap.dir, cap.manifest);
  assertMaterializedDepsContained(cap.dir);
  assertNoNativeBinaries(cap.dir);
  const dest = join(artifactsDir, cap.id);
  mkdirSync(dirname(dest), { recursive: true });
  if (cap.rel === ".") {
    // Legacy flat layout: the capability root IS the staged package root, which
    // other steps still need, so copy instead of moving it out. copyTreeSafe
    // recreates symlinks verbatim — rewriting a link target would change bytes
    // the integrity digest is about to cover — and stays catchable.
    copyTreeSafe(cap.dir, dest);
  } else renameSync(cap.dir, dest);
  writeCapabilityInstallation(dest, cap, pkg);
  return {
    capability: cap.id, version: cap.manifest.version, package: pkg.package, path: cap.rel,
    dir: dest, integrity: capabilityArtifactIntegrity(dest),
    // The DECLARED fundamental layer, normalized to null when the capability
    // declares none. A config template may bind a fundamental slot to one of the
    // root package's own capabilities, and until the artifact is materialized
    // there is nowhere else to read that from — so it belongs in the pre-commit
    // preview, not in a post-commit validation with an outer rollback.
    layer: cap.manifest.layer ?? null,
    executableSurface: executableSurfaceOf(cap.manifest), manifest: cap.manifest,
  };
}

/** Config-template descriptors AND payload bytes, read from a staged package
 * before staging is discarded, so the config lane can offer or adopt a template
 * in the SAME transaction without a second fetch (contract §5.3). Acquisition
 * itself applies none of them. */
/** UTF-8 decoder that REFUSES malformed input instead of substituting U+FFFD, and
 * KEEPS a leading BOM instead of eating it — the returned `content` must
 * re-encode to the exact bytes `contentIntegrity` covers, or an adopter writing
 * the template back would produce a file the digest no longer matches. */
const TEMPLATE_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Read one declared config template into the frozen descriptor shape.
 *
 * `contentIntegrity` digests the EXACT FILE BYTES, not the decoded string.
 * Hashing the string would silently hash U+FFFD replacement characters for any
 * byte sequence Node could not decode, producing a digest nothing can reproduce
 * from the file — and adoption compares template bytes. Config templates are
 * UTF-8 text by contract, so undecodable bytes are a malformed package rather
 * than something to repair: the decode is fail-closed. Both the staged reader
 * (acquisition) and the locked reader go through here, so their descriptors —
 * `legacySpelling` included — cannot drift apart. */
function configTemplateDescriptor(pkgId, dir, name, tpl, legacySpelling) {
  const bytes = readFileSync(join(dir, tpl.path));
  let content;
  try { content = TEMPLATE_DECODER.decode(bytes); }
  catch { throw oasError("invalid-package-manifest", `package "${pkgId}" config template "${name}" (${tpl.path}) is not valid UTF-8 — config templates are UTF-8 text`); }
  return {
    template: name, path: tpl.path,
    ...(tpl.description !== undefined ? { description: tpl.description } : {}),
    default: tpl.default === true,
    content, contentIntegrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
    legacySpelling: legacySpelling === true,
  };
}

function stagedConfigTemplates(pkgId, manifest) {
  const out = [];
  for (const [name, tpl] of Object.entries(manifest._configTemplates || {})) {
    out.push({ package: pkgId, ...configTemplateDescriptor(pkgId, manifest._dir, name, tpl, manifest._legacySpelling) });
  }
  return out;
}

/** Resolve + acquire a package closure at one scope (contract §5.3): fetch the
 * root source and its whole dependency closure into TEMPORARY staging, validate
 * every manifest (official selector / pinned git / local path — no semver
 * solver), detect cycles and identity collisions, MATERIALIZE each declared
 * capability into a flat self-contained artifact under
 * `.agents/capabilities/installed/<id>/`, write the exact lock, and discard
 * staging. A package root is never persisted.
 *
 * Activates nothing and trusts nothing: `trusted` is carried over only for a
 * capability whose newly projected artifact is byte-identical to the one already
 * locked. Transactional: everything validates against staging BEFORE any
 * destination mutation, artifacts swap with backups, and the lock is written
 * once at the end.
 *
 * `opts.assertCommittable(preview)` is a caller-supplied PRE-COMMIT GATE, called
 * once with the complete staged outcome — `{ root, packages, capabilities,
 * configTemplates }`, the same records this function is about to return, with
 * template `content` and `contentIntegrity` included — while the scope is still
 * untouched. It is a PURE GATE: it may only inspect and throw. A throw discards
 * staging and mutates nothing (no ignore file, no artifact, no lock byte), so a
 * refusal needs no rollback. */
export function acquirePackage(levelDir, spec, opts = {}) {
  const lockFile = join(levelDir, OAS_LOCK_FILE);
  // Fail closed on a scope that has not been converted yet, BEFORE any source
  // fetch, staging, ignore or artifact work: current rows cannot be written
  // beside a v1 document, and silently converting one would be exactly the
  // implicit migration the Decision forbids. EVERY v1 is refused, including an
  // empty one — an empty v1 is still an unconverted scope, `lockDraft` refuses
  // it identically, and exempting it here would convert it as a side effect of
  // `oas install` while making the caller pay for a fetch first.
  const existing = levelLockRows(levelDir);
  {
    const strict = parseLockFileStrict(lockFile);
    if (strict && strict.version !== LOCKFILE_VERSION) {
      throw oasError("legacy-lock", `${lockFile} is lockfileVersion ${strict.version} — run \`oas migrate\` at this scope before installing packages`, [{ file: lockFile, lockfileVersion: strict.version }]);
    }
  }
  const { dir: staging, createdAnchors } = makeStaging(levelDir);
  const artifactsDir = join(staging, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const resolved = new Map(); // identity → staged package record
  let counter = 0;
  const resolveClosure = (srcSpec, chain, baseDir) => {
    const p = parsePackageSource(srcSpec, { baseDir });
    const dest = join(staging, `pkg-${counter++}`);
    let commit, packagePath;
    if (!chain.length && opts.rootSnapshot) {
      // payloadDir is the ALREADY-SELECTED contained root, so this copy is the
      // same subtree a fresh fetch would produce — and the layout re-check below
      // is what makes a source mutated between inspection and acquisition fail
      // before any store or lock write.
      if (!opts.rootSnapshot.payloadDir) throw oasError("invalid-source", `inspected Git source has no package at path "${opts.rootSnapshot.path}" for ${srcSpec}`);
      copyTreeSafe(opts.rootSnapshot.payloadDir, dest);
      stripArtifactVcsRoot(dest);
      commit = opts.rootSnapshot.commit;
      packagePath = opts.rootSnapshot.path;
      const packageLayout = existsSync(join(dest, "oas-package.json"));
      const capabilityLayout = existsSync(join(dest, "oas.json"));
      if (packageLayout !== opts.rootSnapshot.payloadPackage || capabilityLayout !== opts.rootSnapshot.payloadCapability || !packageLayout) {
        throw oasError("invalid-source", `inspected Git root layout changed before package acquisition for ${srcSpec}`);
      }
    } else ({ commit, path: packagePath } = fetchPackageSource(p, dest, opts.catalog));
    const m = loadPackageManifestAt(dest);
    const id = m.package;
    if (chain.includes(id)) throw oasError("dependency-cycle", `package dependency cycle: ${[...chain, id].join(" → ")}`, [...chain, id]);
    // Preserve the ORIGINAL catalog spec in lock metadata: bare and explicit
    // selector forms must remain distinguishable for update. The resolved git
    // commit is already pinned separately in `commit`.
    const source = p.kind === "catalog" ? (p.selector ? `catalog:${p.id}@${p.selector}` : `catalog:${p.id}`) : p.kind === "path" ? p.normalized : `git:${p.url}@${p.ref || commit}`;
    // Dedup identity includes the SELECTED ROOT: one repository may legitimately
    // contain several packages (contract §1.1), so two payload roots claiming one
    // package identity are a collision, not the same package resolved twice.
    const sourceKey = `${source}#${packagePath}`;
    if (resolved.has(id)) {
      const prev = resolved.get(id);
      if (prev.sourceKey !== sourceKey) throw oasError("duplicate-package-identity", `two sources claim package "${id}" at ${levelDir}: ${prev.sourceKey} and ${sourceKey}`, [prev.sourceKey, sourceKey]);
      rmSync(dest, { recursive: true, force: true });
      return id;
    }
    const compat = capabilityCompatibility(m);
    if (!compat.compatible) throw oasError("incompatible-oas", `package ${id} requires OAS ${compat.range} (running ${OAS_VERSION})`);
    const deps = [];
    for (const d of m.dependencies || []) {
      // Relative local-path dependencies resolve against the DEPENDING PACKAGE'S
      // source root (contract intent: package-relative), never the process CWD.
      // For git/catalog parents there is no local base.
      const depBase = p.kind === "path" ? p.path : undefined;
      const dp = parsePackageSource(d, { baseDir: depBase });
      if (dp.kind === "git" && !dp.ref) throw oasError("invalid-source", `package dependency must be pinned to a tag/commit: "${d}" (declared by ${id})`);
      // EVERY relative path dependency requires a local base — classified from
      // the parsed payload so "path:sub" / whitespace spellings cannot resolve
      // through the process CWD from a git/catalog manifest (reviewer-2a4adec).
      if (dp.kind === "path" && dp.relative && !depBase) throw oasError("invalid-source", `package dependency "${d}" (declared by ${id}) is a relative path, but ${id} was not acquired from a local path — relative dependencies only work between co-located local packages`);
      deps.push(resolveClosure(d, [...chain, id], depBase));
    }
    resolved.set(id, {
      package: id, dir: dest, manifest: m, source, path: packagePath, sourceKey, commit,
      version: m.version, integrity: packageIntegrity(dest), deps, capabilities: m._capabilities,
    });
    return id;
  };
  try {
    const rootId = resolveClosure(spec, [], undefined);
    if (opts.expectPackage && rootId !== opts.expectPackage) {
      throw oasError("duplicate-package-identity", `source ${spec} no longer provides root package "${opts.expectPackage}" (root resolved to "${rootId}")`);
    }
    // Same-scope capability-ID collisions: within the closure, and against
    // capabilities already locked at this scope by packages OUTSIDE it.
    const capOwner = new Map();
    for (const [cid, row] of Object.entries(existing.capabilities)) {
      if (!resolved.has(row.package)) capOwner.set(cid, row.package);
    }
    for (const [pid, r] of resolved) {
      for (const c of r.capabilities) {
        if (capOwner.has(c.id) && capOwner.get(c.id) !== pid) throw oasError("duplicate-capability-id", `capability "${c.id}" is exported by both package "${capOwner.get(c.id)}" and package "${pid}" at ${levelDir}`, [capOwner.get(c.id), pid]);
        capOwner.set(c.id, pid);
      }
    }
    // A locked source never advances on acquire (only `oas update` may): the
    // selected root is checked before integrity, because two different roots can
    // hold byte-identical trees and that must not silently rewrite the path.
    for (const [pid, r] of resolved) {
      const prior = Object.hasOwn(existing.packages, pid) ? existing.packages[pid] : undefined;
      if (!prior || opts.replace) continue;
      // The way OUT of a path mismatch depends on who owns the selected root.
      // `oas update` re-resolves from the locked source: a catalog entry owns
      // its `path`, so an update adopts a moved root; a git spec's "#<path>" is
      // the operator's OWN selection and stays sticky, so recommending update
      // there would name a command that cannot resolve it. Local sources are
      // always the exact directory (path "."), so they never reach this.
      if (prior.path !== r.path) {
        const lockedKind = (() => { try { return parseLockSource(prior.source).kind; } catch { return undefined; } })();
        const route = lockedKind === "git"
          ? `a git source's "#<path>" is your own selection, so \`oas update ${pid}\` would keep "${prior.path}". To move it, \`oas remove ${pid}\` (refused while config or dependent packages still reference it), then re-install the git source with the intended "#<path>"`
          : `use \`oas update ${pid}\``;
        throw oasError("integrity-drift", `package "${pid}" resolves to package path "${r.path}" but the existing lock records "${prior.path}" — a locked source never advances on acquire; ${route}`);
      }
      if (prior.integrity !== r.integrity) throw oasError("integrity-drift", `package "${pid}" resolves to integrity ${r.integrity} but the existing lock records ${prior.integrity} — a locked source never advances on acquire; use \`oas update ${pid}\``);
    }
    // TRANSACTION-WIDE platform-invariance preflight over every materialization
    // root BEFORE any npm ci, so a clean closure cannot materialize ahead of a
    // rejected sibling (reviewer-11752b2).
    assertPlatformInvariantLocks([...resolved.values()].flatMap((r) => r.capabilities.map((c) => c.dir)));
    // Project every capability of the closure, in staging.
    const projected = [];
    const configTemplates = [];
    for (const [, r] of resolved) {
      for (const cap of r.capabilities) projected.push(materializeCapability({ cap, pkg: r, artifactsDir }));
      configTemplates.push(...stagedConfigTemplates(r.package, r.manifest));
    }
    // Trust is carried over ONLY for a byte-identical artifact — that is the
    // whole meaning of "trust binds to the capability integrity". Everything
    // else lands untrusted, including a brand-new acquisition.
    for (const proj of projected) {
      const prior = Object.hasOwn(existing.capabilities, proj.capability) ? existing.capabilities[proj.capability] : undefined;
      const same = prior && prior.integrity === proj.integrity && prior.package === proj.package;
      proj.trusted = !!(same && prior.trusted);
      const dest = installedCapabilityDir(levelDir, proj.capability);
      proj.installedDir = dest;
      proj.status = !existsSync(dest) ? "installed"
        : same && capabilityArtifactIntegrity(dest) === proj.integrity ? "kept"
          : "replaced";
    }
    // PRE-COMMIT GATE (contract §5.3). The caller sees the COMPLETE staged
    // outcome — the same records `acquirePackage` is about to return — while
    // nothing in the scope has been touched: no ignore file, no artifact, no
    // lock byte. Throwing from here discards staging and mutates nothing, which
    // is what lets guided `oas init --package` present and validate the whole
    // selected plan (including template bytes and digests) before committing,
    // and what lets `oas update` refuse an export drop byte-exactly. Judging the
    // result after the commit cannot achieve either: putting "the previous
    // version" back re-acquires from a source that has itself moved on.
    if (opts.assertCommittable) {
      opts.assertCommittable({
        root: rootId,
        packages: [...resolved.values()].map((r) => ({
          package: r.package, version: r.version, source: r.source, path: r.path, commit: r.commit,
          integrity: r.integrity, dependencies: [...new Set(r.deps)].sort(),
          capabilities: r.capabilities.map((c) => c.id),
        })),
        capabilities: projected.map((p) => ({
          capability: p.capability, version: p.version, package: p.package, path: p.path,
          integrity: p.integrity, trusted: p.trusted, status: p.status, layer: p.layer,
          executableSurface: p.executableSurface,
        })),
        configTemplates,
      });
    }
    // COMMIT. Generated artifacts must never become committable, so the scope's
    // ignore is ensured FIRST and fails the operation before anything durable
    // moves (contract §3.3). Then artifacts swap with backups and the lock is
    // written once. ANY failure — including one during the swap or the lock
    // write — rolls artifacts, lock bytes and ignore bytes back.
    const ignore = ensureInstalledGitignorePreflight(levelDir);
    const originalLock = existsSync(lockFile) ? readFileSync(lockFile, "utf8") : null;
    const done = []; // { dest, backup? }
    try {
      for (const proj of projected) {
        if (proj.status === "kept") continue;
        const dest = proj.installedDir;
        let backup;
        if (existsSync(dest)) { backup = join(staging, `backup-${proj.capability}`); renameSync(dest, backup); }
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(proj.dir, dest);
        proj.dir = dest;
        done.push({ dest, backup });
      }
      for (const proj of projected) proj.dir = proj.installedDir;
      writeLockEntries(levelDir, {
        packages: Object.fromEntries([...resolved.values()].map((r) => [r.package, {
          source: r.source, path: r.path, version: r.version, commit: r.commit, integrity: r.integrity,
          dependencies: [...new Set(r.deps)].sort(),
        }])),
        capabilities: Object.fromEntries(projected.map((p) => [p.capability, {
          version: p.version, package: p.package, path: p.path, integrity: p.integrity, trusted: p.trusted,
        }])),
        replacePackages: [...resolved.keys()],
      });
    } catch (e) {
      for (const d of done.reverse()) {
        rmSync(d.dest, { recursive: true, force: true });
        if (d.backup && existsSync(d.backup)) renameSync(d.backup, d.dest);
      }
      if (originalLock === null) rmSync(lockFile, { force: true });
      else writeFileSync(lockFile, originalLock);
      ignore.rollback();
      throw e;
    }
    return {
      root: rootId, lockFile,
      installed: [...resolved.values()].map((r) => ({
        package: r.package, version: r.version, source: r.source, path: r.path, commit: r.commit,
        integrity: r.integrity, dependencies: [...new Set(r.deps)].sort(),
        capabilities: r.capabilities.map((c) => c.id),
        kept: r.capabilities.every((c) => projected.find((p) => p.capability === c.id)?.status === "kept"),
      })),
      capabilities: projected.map((p) => ({
        capability: p.capability, version: p.version, package: p.package, path: p.path,
        integrity: p.integrity, dir: p.dir, trusted: p.trusted, status: p.status, layer: p.layer,
        executableSurface: p.executableSurface,
      })),
      configTemplates,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    // Staging had to live inside the store, so on a scope that had none this
    // operation created `.agents/`, `.agents/capabilities/` and `installed/`.
    // A refused or failed acquisition must leave the scope untouched, so undo
    // exactly those — deepest-first, only while empty, never a pre-existing one.
    pruneCreatedAnchors(createdAnchors);
  }
}

/** Semantic lock-entry validation for a PACKAGE row (runtime API addendum §4):
 * source/commit pairing, canonical path, dependency references (incl. self and
 * cycle over the locked graph), digest shapes, uniqueness. Run BEFORE restore,
 * trust/approval, update/remove/migration planning, the locked-template reader,
 * and doctor/list consumption. Fails closed with code "invalid-lock" carrying
 * file/package provenance; never normalizes or auto-repairs on read. */
export function validateLockEntry(packageId, entry, allPackages = {}, opts = {}) {
  const where = opts.file ? ` (${opts.file})` : "";
  const bad = (msg) => oasError("invalid-lock", `lock entry for package "${packageId}"${where} is invalid: ${msg}`, [{ package: packageId, file: opts.file, violation: msg }]);
  if (!entry || typeof entry !== "object") throw bad("not an object");
  for (const k of ["source", "path", "version", "commit", "integrity"]) if (!entry[k] || typeof entry[k] !== "string") throw bad(`missing ${k}`);
  // The selected package root is a STRICT separate field (contract §1.1) stored
  // in canonical form only — a lock is never normalized or repaired on read, so
  // a non-canonical spelling ("./sub", "sub/", "") is invalid, not silently
  // accepted. That is what makes the root representation round-trip.
  {
    let canonical;
    try { canonical = normalizePackagePath(entry.path, { where: "path", code: "invalid-lock" }); }
    catch (e) { throw bad(`invalid path ${JSON.stringify(entry.path)} — ${e.message}`); }
    if (canonical !== entry.path) throw bad(`path ${JSON.stringify(entry.path)} is not in canonical form (expected ${JSON.stringify(canonical)})`);
  }
  if (!/^sha256-[0-9a-f]{64}$/.test(entry.integrity)) throw bad(`malformed integrity "${entry.integrity}"`);
  // Present-but-wrong-typed optional fields are invalid — default ONLY when absent.
  // `dependencies` is ALWAYS recorded (empty array when none), so a reader never
  // has to distinguish absent from empty.
  if (!Array.isArray(entry.dependencies)) throw bad("dependencies must be an array (empty when the package has none)");
  for (const d of entry.dependencies) if (typeof d !== "string" || !PACKAGE_ID_RE.test(d)) throw bad(`dependencies contains an invalid package id ${JSON.stringify(d)}`);
  if (new Set(entry.dependencies).size !== entry.dependencies.length) throw bad("dependencies contains duplicates");
  // Package rows lock transport only. A capability list, a trust list or a
  // dependency-closure digest here is the unsupported transitional shape — the
  // central parser rejects those documents outright (contract §4.1); this is
  // the entry-level backstop for a row reaching validation another way.
  for (const gone of TRANSITIONAL_ROW_FIELDS) {
    if (Object.hasOwn(entry, gone)) throw bad(`"${gone}" is a transitional package-root field — package rows lock transport only (capabilities and trust live on capability rows)`);
  }
  let src;
  try { src = parseLockSource(entry.source); } catch { throw bad(`unrecognized source "${entry.source}"`); }
  if (src.kind === "path" && !src.path) throw bad("empty path source");
  if (src.kind === "git" && !src.url) throw bad("empty git source");
  if (src.kind === "catalog" && !src.id) throw bad("empty catalog source");
  if (src.kind === "path") {
    if (entry.commit !== "local") throw bad(`path source requires commit "local", got "${entry.commit}"`);
    // Local acquisition is exact-directory: the source string already names the
    // package root, so the only valid contained path is the root itself.
    if (entry.path !== ".") throw bad(`path source requires path "." (local sources are exact directories), got ${JSON.stringify(entry.path)}`);
  }
  else if (!/^[0-9a-f]{40}$/.test(entry.commit)) throw bad(`${src.kind} source requires an exact 40-hex commit, got "${entry.commit}"`);
  for (const d of entry.dependencies || []) {
    if (d === packageId) throw bad(`self-dependency "${d}"`);
    // Object.hasOwn: a dependency literally named "constructor"/"__proto__"
    // must not pass via Object.prototype.
    if (!Object.hasOwn(allPackages, d)) throw bad(`dependency "${d}" is not locked in the same packages map`);
  }
  // Cycle over the locked dependency graph reachable from this entry.
  const visiting = new Set();
  const visited = new Set();
  const walk = (id, chain) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw bad(`dependency cycle in the locked graph: ${[...chain, id].join(" → ")}`);
    visiting.add(id);
    const deps = Object.hasOwn(allPackages, id) && Array.isArray(allPackages[id]?.dependencies) ? allPackages[id].dependencies : [];
    for (const d of deps) if (Object.hasOwn(allPackages, d) || d === packageId) walk(d, [...chain, id]);
    visiting.delete(id); visited.add(id);
  };
  walk(packageId, []);
  return true;
}

/** Semantic validation of one CAPABILITY row against the whole document
 * (contract §4). The `package` back-reference must name a locked package: it is
 * the single provider truth, so a dangling reference would leave a materialized
 * artifact with no provenance to restore or verify it from. */
export function validateCapabilityLockEntry(capabilityId, entry, allPackages = {}, opts = {}) {
  const where = opts.file ? ` (${opts.file})` : "";
  const bad = (msg) => oasError("invalid-lock", `capability lock entry for "${capabilityId}"${where} is invalid: ${msg}`, [{ package: capabilityId, file: opts.file, violation: msg }]);
  if (typeof capabilityId !== "string" || !capabilityId) throw bad("empty capability id");
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw bad("not an object");
  for (const k of ["version", "package", "path", "integrity"]) if (!entry[k] || typeof entry[k] !== "string") throw bad(`missing ${k}`);
  if (!PACKAGE_ID_RE.test(entry.package)) throw bad(`provider package ${JSON.stringify(entry.package)} is not a valid package identity`);
  if (!Object.hasOwn(allPackages, entry.package)) throw bad(`provider package "${entry.package}" is not locked in the same packages map`);
  {
    let canonical;
    try { canonical = normalizePackagePath(entry.path, { where: "path", code: "invalid-lock" }); }
    catch (e) { throw bad(`invalid path ${JSON.stringify(entry.path)} — ${e.message}`); }
    if (canonical !== entry.path) throw bad(`path ${JSON.stringify(entry.path)} is not in canonical form (expected ${JSON.stringify(canonical)})`);
  }
  if (!/^sha256-[0-9a-f]{64}$/.test(entry.integrity)) throw bad(`malformed integrity "${entry.integrity}"`);
  if (typeof entry.trusted !== "boolean") throw bad(`"trusted" must be a boolean (got ${JSON.stringify(entry.trusted)})`);
  return true;
}

/** Fetch ONE locked package's exact provenance into staging and return the
 * verified payload root. Used by restore, update planning, migration and the
 * locked-template reader — every path that needs the exact bytes a package row
 * pins, without ever persisting a package root.
 *
 * The LOCKED path wins over anything the source or catalog says now: an upstream
 * that moved its package root, or a catalog entry that repointed, must not change
 * what a bare restore installs (contract §9). */
function fetchLockedPackage(lock, dest, catalog, { verifyIntegrity = true } = {}) {
  const src = parseLockSource(lock.source);
  fetchPackageSource(src, dest, catalog, { commit: src.kind === "path" ? undefined : lock.commit, path: lock.path });
  const integrity = packageIntegrity(dest);
  if (verifyIntegrity && integrity !== lock.integrity) {
    throw oasError("integrity-drift", `package payload integrity ${integrity} does not match locked ${lock.integrity}; the source has drifted — reacquire explicitly`);
  }
  return { dir: dest, manifest: loadPackageManifestAt(dest), integrity };
}

/** Locate one capability inside a fetched package payload, at the path the lock
 * pins. A package that no longer exports it there is `capability-list-mismatch`:
 * the lock's provider claim and the manifest disagree, which is exactly the
 * condition bare restore must refuse rather than silently reproject something
 * else. */
function lockedCapabilityOf(manifest, capabilityId, lock, packageId) {
  const cap = manifest._capabilities.find((c) => c.id === capabilityId);
  if (!cap) throw oasError("capability-list-mismatch", `package ${packageId} no longer exports capability "${capabilityId}" (it exports [${manifest._capabilities.map((c) => c.id).join(", ") || "none"}])`);
  if (cap.rel !== lock.path) throw oasError("capability-list-mismatch", `package ${packageId} exports capability "${capabilityId}" from "${cap.rel}" but the lock pins "${lock.path}" — only \`oas update ${packageId}\` may move a capability root`);
  return cap;
}

/** Bare restore from the locks in the visible chain (contract §5.3).
 *
 * Preflight parses and caches the COMPLETE visible chain before any fetch,
 * staging or swap: a valid outer lock must not restore an artifact before a
 * malformed inner lock-only scope raises invalid-lock (reviewer-fe42de8).
 *
 * Per capability: a present artifact whose integrity equals the locked integrity
 * is `ok`. Otherwise the provider package's exact locked provenance is fetched
 * ONCE per package, its payload integrity is verified against the package row,
 * the capability is reprojected, its artifact integrity is verified against the
 * capability row, and only then swapped in. Nothing ever advances, and `trusted`
 * is never changed. */
export function restorePackages(startDir, opts = {}) {
  const report = [];
  const locks = lockLevels(startDir).map((level) => {
    const file = join(level, OAS_LOCK_FILE);
    return { level, file, strict: parseLockFileStrict(file) };
  });
  for (const { level, strict } of locks) {
    if (!strict) continue;
    if (strict.version !== LOCKFILE_VERSION) {
      report.push({ package: null, capability: null, level, status: "legacy", lockfileVersion: strict.version, reason: `lockfileVersion ${strict.version} — run \`oas migrate --dir ${level}\` to materialize its capabilities` });
      continue;
    }
    // One fetch per package serves all of its capabilities that need reprojecting.
    const fetched = new Map(); // packageId → { dir, manifest } | { error }
    const { dir: staging, createdAnchors } = makeStaging(level);
    try {
      for (const [capId, lock] of Object.entries(strict.capabilities)) {
        const dest = installedCapabilityDir(level, capId);
        try {
          if (existsSync(dest) && capabilityArtifactIntegrity(dest) === lock.integrity) {
            report.push({ package: lock.package, capability: capId, level, status: "ok", dir: dest });
            continue;
          }
          const pkgLock = strict.packages[lock.package];
          if (!fetched.has(lock.package)) {
            try { fetched.set(lock.package, fetchLockedPackage(pkgLock, join(staging, `pkg-${lock.package}`), opts.catalog)); }
            catch (e) { fetched.set(lock.package, { error: e }); }
          }
          const got = fetched.get(lock.package);
          if (got.error) throw got.error;
          const cap = lockedCapabilityOf(got.manifest, capId, lock, lock.package);
          const pkgRecord = { package: lock.package, version: pkgLock.version, source: pkgLock.source, commit: pkgLock.commit, path: pkgLock.path };
          const proj = materializeCapability({ cap, pkg: pkgRecord, artifactsDir: join(staging, "artifacts") });
          if (proj.integrity !== lock.integrity) {
            throw oasError("integrity-drift", `reprojected capability ${capId} integrity ${proj.integrity} does not match locked ${lock.integrity}`);
          }
          // Swap with a backup so a rename failure cannot lose the prior artifact.
          const replaced = existsSync(dest);
          const backup = join(staging, `backup-${capId}`);
          if (replaced) renameSync(dest, backup);
          mkdirSync(dirname(dest), { recursive: true });
          try { renameSync(proj.dir, dest); }
          catch (e) { if (replaced) renameSync(backup, dest); throw e; }
          report.push({ package: lock.package, capability: capId, level, status: "restored", dir: dest, replaced });
        } catch (e) {
          report.push({ package: lock.package, capability: capId, level, status: "failed", reason: e.message, code: e.code });
        }
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
      pruneCreatedAnchors(createdAnchors);
    }
    // A package row with no capability row left is lock corruption the schema
    // cannot express as an error (an empty export set is legal mid-history), so
    // report it rather than hide it.
    for (const pid of Object.keys(strict.packages)) {
      if (!Object.values(strict.capabilities).some((c) => c.package === pid)) {
        report.push({ package: pid, capability: null, level, status: "failed", code: "capability-list-mismatch", reason: `package "${pid}" is locked but supplies no locked capability — reacquire or remove it` });
      }
    }
    ensureInstalledGitignore(level);
  }
  return report;
}

/** Derive the package/provider view from the lock + the FLAT capability store
 * (contract §5.3) — there is no package root to enumerate. Closest scope wins
 * per package identity; two same-scope packages claiming one capability ID is
 * duplicate-capability-id.
 *
 * A locked-but-not-materialized capability is reported with `installed: false`
 * rather than hidden: that is exactly what a bare `oas install` repairs, and
 * hiding it would make a broken deployment render as healthy. */
export function listInstalledPackages(startDir) {
  const byId = new Map();
  for (const level of lockLevels(startDir)) {
    const { packages, capabilities } = levelLockRows(level); // raises invalid-lock on any violation
    const capOwner = new Map();
    for (const [cid, row] of Object.entries(capabilities)) {
      if (capOwner.has(cid)) throw oasError("duplicate-capability-id", `capability "${cid}" is claimed by both package "${capOwner.get(cid)}" and package "${row.package}" at ${level}`, [capOwner.get(cid), row.package]);
      capOwner.set(cid, row.package);
    }
    for (const [pid, p] of Object.entries(packages)) {
      const caps = [];
      for (const [cid, row] of Object.entries(capabilities)) {
        if (row.package !== pid) continue;
        const dir = installedCapabilityDir(level, cid);
        const installed = existsSync(join(dir, "oas.json"));
        let manifest;
        if (installed) { try { manifest = loadManifestAt(dir, `installed:${level}`); } catch { /* doctor reports a broken artifact */ } }
        caps.push({ id: cid, version: row.version, path: row.path, dir, integrity: row.integrity, trusted: row.trusted === true, installed, ...(manifest ? { manifest } : {}) });
      }
      // Keyed by LEVEL AND ID, not id alone: two scopes may lock the same
      // package identity at different versions with DISJOINT exports, and
      // collapsing them would discard the outer scope's capabilities entirely —
      // they are locked and materialized, and list/doctor must still see them.
      // The array stays outermost → innermost, so callers resolving an IDENTITY
      // take the LAST match (closest wins, matching the merged lock maps).
      byId.set(`${level}\u0000${pid}`, {
        package: pid, version: p.version, level, lockfileVersion: LOCKFILE_VERSION,
        source: p.source, path: p.path, commit: p.commit, integrity: p.integrity, locked: true,
        dependencies: p.dependencies || [],
        capabilities: caps.sort((a, b) => a.id.localeCompare(b.id)),
      });
    }
  }
  return [...byId.values()];
}

/** Approve executable surfaces (contract §5.4). Per-capability by default;
 * `allCapabilities` treats `id` as a PACKAGE identity and approves every
 * capability that package currently supplies — the explicit bulk path, after
 * the CLI has shown the full executable-surface summary.
 *
 * Approval is bound to the capability's exact MATERIALIZED ARTIFACT integrity,
 * never to package identity: a drifted artifact cannot be approved, and any
 * later change resets `trusted` to false. Non-executable capabilities need no
 * approval (reported in `skipped`). Official catalog identity grants nothing.
 *
 * Integrity equality is necessary but NOT sufficient, and approval is the worst
 * moment to assume otherwise: a `.oas-installation.json` edited and then
 * re-hashed into its capability row leaves every byte matching its recorded
 * digest with only the ORIGIN disagreeing. So each target's provenance is
 * verified against the capability and provider package rows it was projected
 * from before any flag is set. Both preconditions are checked for EVERY target
 * before the single lock write, so a bulk package approval commits nothing when
 * one capability's origin is disputed. */
export function approveCapability(startDir, id, { allCapabilities } = {}) {
  const locks = readPackageLocks(startDir);
  const rows = Object.entries(locks.capabilities);
  // A PACKAGE identity resolves to exactly ONE scope — the closest lock that
  // locks it — and only that scope's capability rows are this command's to
  // approve. Filtering the merged map by `row.package === id` alone would
  // collect rows from outer levels and then write them all into the closest
  // lock, inventing entries that level never had. A CAPABILITY identity keeps
  // its own closest-wins precedence.
  const provider = allCapabilities && Object.hasOwn(locks.packages, id) ? locks.packages[id] : undefined;
  const targets = allCapabilities
    ? (provider ? rows.filter(([, row]) => row.package === id && row._file === provider._file) : [])
    : rows.filter(([cid]) => cid === id);
  if (!targets.length) {
    throw oasError("unknown-capability", allCapabilities
      ? `no locked package "${id}" supplies any capability in this chain`
      : `no locked capability "${id}" in this chain`);
  }
  const level = targets[0][1]._level;
  const surface = {};
  const approved = [];
  const skipped = [];
  const updates = {};
  for (const [cid, row] of targets) {
    const dir = installedCapabilityDir(row._level, cid);
    if (!existsSync(dir)) throw oasError("unknown-capability", `capability "${cid}" is locked but not materialized at ${dir} — run \`oas install\` first`);
    const integrity = capabilityArtifactIntegrity(dir);
    if (integrity !== row.integrity) throw oasError("integrity-drift", `capability ${cid} artifact integrity changed (${row.integrity} → ${integrity}); restore or update explicitly before trusting`);
    // The artifact's own provenance and the lock must tell the same story before
    // an executable surface is unlocked. Integrity cannot see this: rebinding the
    // capability row's hash to a tampered artifact satisfies the check above.
    // The provider row is guaranteed present: readPackageLocks strict-parses
    // every capability entry and already refuses a row whose provider is not in
    // the same packages map, so this cannot be reached with an absent one — and
    // it is resolved at THAT level, never from the merged map, which may hold a
    // same-named package from a nearer scope.
    verifyCapabilityInstallation(dir, cid, row, providerPackageRow(locks, row));
    let manifest;
    try { manifest = loadManifestAt(dir, `installed:${row._level}`); }
    catch (e) { throw oasError("integrity-drift", `capability ${cid} artifact is unreadable: ${e.message}`); }
    surface[cid] = executableSurfaceOf(manifest);
    if (hasExecutableSurface(manifest)) {
      approved.push(cid);
      const { _file, _level, ...clean } = row;
      updates[cid] = { ...clean, trusted: true };
    } else skipped.push(cid);
  }
  const file = Object.keys(updates).length ? writeLockEntries(level, { capabilities: updates }) : targets[0][1]._file;
  return { package: targets[0][1].package, approved, skipped, executableSurface: surface, file, level };
}

/** Transactional package update (contract §5.5): re-resolve the closure from the
 * row's ORIGINAL spec (or opts.spec), validate everything in staging, then
 * replace ALL of that package's exported capability artifacts and lock rows
 * together.
 *
 * Trust survives only for capabilities whose new artifact is byte-identical
 * (acquirePackage carries it over on exactly that condition). Exports that no
 * longer exist are retired ONLY when safe — no config in the chain references
 * them — otherwise the whole update fails `remove-blocked` BEFORE anything is
 * fetched or replaced. */
export function updatePackage(startDir, packageId, opts = {}) {
  const locks = readPackageLocks(startDir);
  const entry = locks.packages[packageId];
  if (!entry) throw oasError("unknown-capability", `package "${packageId}" is not locked in any ${OAS_LOCK_FILE} in this chain`);
  const level = entry._level;
  const own = levelLockRows(level); // full-scope strict validation before acting
  const src = parseLockSource(entry.source);
  // Re-resolve from the un-pinned identity: catalog id (fresh selector), git url
  // at its recorded ref (tags may move; unpinned = default branch), or path. The
  // SELECTED ROOT round-trips differently per source kind: a git spec's path is
  // the user's own selection, so it is re-appended and stays sticky across
  // updates; a catalog entry OWNS its path, so an update deliberately re-reads it
  // and may adopt a moved root (reported below).
  const spec = opts.spec || (src.kind === "catalog" ? (src.selector ? `${src.id}@${src.selector}` : src.id)
    : src.kind === "git" ? `${src.ref && !/^[0-9a-f]{40}$/.test(src.ref) ? `${src.url}@${src.ref}` : src.url}#${entry.path}`
      : src.path);
  const beforeCaps = Object.entries(own.capabilities).filter(([, r]) => r.package === packageId).map(([cid, r]) => ({ capability: cid, ...r }));
  const before = {
    version: entry.version, commit: entry.commit, integrity: entry.integrity, path: entry.path,
    capabilities: beforeCaps.map((c) => c.capability).sort(),
    trustedCapabilities: beforeCaps.filter((c) => c.trusted).map((c) => c.capability).sort(),
  };
  // A removed export whose config reference is still live would leave the
  // deployment pointing at a capability nothing can supply. The check runs as a
  // PRE-COMMIT gate inside the transaction, so a refusal leaves the lock bytes
  // and every artifact exactly as they were — re-acquiring the previous version
  // afterwards could not do that, because the source itself has moved on.
  const assertCommittable = (plan) => {
    const staged = plan.packages.find((p) => p.package === packageId)?.capabilities || [];
    const removed = before.capabilities.filter((c) => !staged.includes(c));
    if (!removed.length) return;
    const blockers = [];
    for (const cfg of configChain(startDir)) {
      for (const { id, slot } of configCapabilityEntries(cfg)) {
        if (removed.includes(id)) blockers.push(`${cfg._file} references capability "${id}"${slot ? ` (${slot} layer)` : ""}`);
      }
    }
    if (blockers.length) throw oasError("remove-blocked", `cannot update package "${packageId}": it no longer exports ${removed.join(", ")}, but\n  - ${blockers.join("\n  - ")}\nRemove the config references first, then update.`, blockers);
  };
  // expectPackage makes an identity change a PRE-COMMIT failure inside
  // acquirePackage (nothing installed/locked if the source renamed itself).
  const r = acquirePackage(level, spec, { ...opts, replace: true, expectPackage: packageId, assertCommittable });
  const after = r.installed.find((p) => p.package === packageId);
  if (!after) throw oasError("duplicate-package-identity", `source ${spec} no longer provides package "${packageId}" (root resolved to "${r.root}")`);
  // The lock rows for dropped exports are already gone (replacePackages); retire
  // their artifacts so no orphan is left behind claiming to be installed.
  const removedCapabilities = before.capabilities.filter((c) => !after.capabilities.includes(c));
  for (const cid of removedCapabilities) rmSync(installedCapabilityDir(level, cid), { recursive: true, force: true });
  const changed = after.integrity !== before.integrity;
  return {
    package: packageId, level, changed, pathChanged: after.path !== before.path, before, after,
    installed: r.installed, capabilities: r.capabilities, configTemplates: r.configTemplates,
    addedCapabilities: after.capabilities.filter((c) => !before.capabilities.includes(c)),
    removedCapabilities, retiredArtifacts: removedCapabilities,
    invalidatedApprovals: before.trustedCapabilities.filter((c) => !r.capabilities.some((p) => p.capability === c && p.trusted)),
  };
}

/** Remove one locked package and every capability artifact it supplied
 * (contract §5.5). Refuses while another locked package in the TARGET ENTRY'S
 * OWN scope map depends on it, or any config in the chain references one of its
 * capabilities — the closest-wins merged chain is for lookup, never for
 * authorizing a mutation. Transactional on both sides. */
export function removePackage(startDir, packageId) {
  const locks = readPackageLocks(startDir);
  const entry = locks.packages[packageId];
  if (!entry) throw oasError("unknown-capability", `package "${packageId}" is not locked in any ${OAS_LOCK_FILE} in this chain`);
  const level = entry._level;
  const own = levelLockRows(level);
  const exported = Object.entries(own.capabilities).filter(([, r]) => r.package === packageId).map(([cid]) => cid);
  const blockers = [];
  for (const [pid, e] of Object.entries(own.packages)) {
    if (pid !== packageId && (e.dependencies || []).includes(packageId)) blockers.push(`package "${pid}" (locked in ${entry._file}) depends on it`);
  }
  for (const cfg of configChain(startDir)) {
    for (const { id, slot } of configCapabilityEntries(cfg)) {
      if (exported.includes(id)) blockers.push(`${cfg._file} references capability "${id}"${slot ? ` (${slot} layer)` : ""}`);
    }
  }
  if (blockers.length) throw oasError("remove-blocked", `cannot remove package "${packageId}":\n  - ${blockers.join("\n  - ")}\nRemove the config references / dependent packages first.`, blockers);
  const originalLock = readFileSync(entry._file, "utf8");
  const { dir: staging, createdAnchors } = makeStaging(level);
  const moved = [];
  try {
    for (const cid of exported) {
      const dir = installedCapabilityDir(level, cid);
      if (!existsSync(dir)) continue;
      const backup = join(staging, cid);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(dir, backup);
      moved.push({ dir, backup });
    }
    writeLockEntries(level, {
      packages: { [packageId]: null },
      capabilities: Object.fromEntries(exported.map((c) => [c, null])),
    });
  } catch (e) {
    // Roll BOTH sides back: original lock bytes and every moved artifact.
    try { if (readFileSync(entry._file, "utf8") !== originalLock) writeFileSync(entry._file, originalLock); } catch { /* preserve the original failure */ }
    for (const m of moved.reverse()) {
      rmSync(m.dir, { recursive: true, force: true });
      if (existsSync(m.backup)) renameSync(m.backup, m.dir);
    }
    rmSync(staging, { recursive: true, force: true });
    pruneCreatedAnchors(createdAnchors);
    throw e;
  }
  rmSync(staging, { recursive: true, force: true });
  // A remove that emptied the store takes the anchors it created with it.
  pruneCreatedAnchors(createdAnchors);
  return { package: packageId, level, capabilities: exported, lockFile: entry._file };
}

/** Read config templates from the EXACT currently locked source of one package
 * (contract §5.6) — the config lane's `oas config diff` / `sync` / `adopt` input.
 *
 * Stages the locked source, validates the manifest, verifies the payload
 * integrity against the package row, reads the requested template bytes, and
 * removes staging. It NEVER persists a package root, never exposes a path into
 * one, never mutates the lock or the capability store, and never advances
 * anything. Omit `opts.template` for every template the package ships. */
export function readLockedConfigTemplates(startDir, packageId, opts = {}) {
  const locks = readPackageLocks(startDir);
  const entry = locks.packages[packageId];
  if (!entry) throw oasError("unknown-capability", `package "${packageId}" is not locked in any ${OAS_LOCK_FILE} in this chain`);
  const tmp = mkdtempSync(join(tmpdir(), "oas-template-"));
  try {
    const { manifest } = fetchLockedPackage(entry, join(tmp, "pkg"), opts.catalog);
    const available = manifest._configTemplates || {};
    const wanted = opts.template === undefined ? Object.keys(available) : [opts.template];
    for (const name of wanted) {
      if (!Object.hasOwn(available, name)) {
        throw oasError("unknown-config-template", `package "${packageId}" has no config template "${name}"${Object.keys(available).length ? ` (available: ${Object.keys(available).join(", ")})` : " (it ships none)"}`);
      }
    }
    const templates = wanted.map((name) => configTemplateDescriptor(packageId, manifest._dir, name, available[name], manifest._legacySpelling));
    return {
      package: packageId, source: entry.source, version: entry.version, commit: entry.commit,
      path: entry.path, integrity: entry.integrity,
      legacySpelling: manifest._legacySpelling === true, templates,
    };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Validate one LEGACY (lockfileVersion 1) capability lock entry against the v1
 * schema shape; returns null when valid or a violation string.
 *
 * Engine-internal: the strict reader uses it so a malformed v1 entry is refused
 * before any consumer sees the map. It is deliberately NOT a "residue" check —
 * migration produces no residue, and the superseded transitional v2 shape is
 * rejected wholesale rather than partially parsed. */
export function legacyCapabilityEntryViolation(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "not an object";
  for (const k of ["source", "version", "integrity"]) if (typeof entry[k] !== "string" || !entry[k]) return `missing/invalid ${k}`;
  if (!/^sha256-[0-9a-f]{64}$/.test(entry.integrity)) return `malformed integrity "${entry.integrity}"`;
  if (entry.commit !== undefined && typeof entry.commit !== "string") return "invalid commit";
  if (entry.trustedExecutables !== undefined && typeof entry.trustedExecutables !== "boolean") return "invalid trustedExecutables";
  return null;
}

/** Atomic file replacement: write to a same-directory temp file, then rename
 * over the destination — an interrupted write leaves the original bytes intact
 * (reviewer-21849d4). */
function atomicWriteFileSync(file, content) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Plan the conversion of ONE scope's v1 lock into capability materialization
 * (contract §5.7). PURE mapping: `applyLegacyLockMigration` applies it.
 *
 * `marketplace:<id>` entries map to official catalog specs; `git:`/`path:`
 * entries map to package sources. There is NO residue container in the current
 * lock, so an entry that cannot be mapped makes the WHOLE SCOPE unconvertible:
 * it is reported (`manual`/`hold`) and the scope stays v1 and keeps working,
 * rather than being half-converted.
 *
 * `opts.official` is the GUIDED existing-user upgrade (0.18 bundled official
 * capabilities → official packages) and changes three things:
 *   - `marketplace:` entries resolve through the catalog's capability aliases
 *     (oas.review → package oas.dev), and the spec is the BARE catalog id: the
 *     catalog owns the release ref, never a tag guessed from the v1 version;
 *   - a legacy official capability with no catalog mapping is `hold` — the scope
 *     is left untouched instead of half-converted;
 *   - non-official entries (git/path/unknown/retired) are `retain`: never
 *     acquired, never rewritten, kept exactly as they are. */
export function migrateLegacyLock(levelDir, opts = {}) {
  const file = join(levelDir, OAS_LOCK_FILE);
  const plan = [];
  const warnings = [];
  if (!existsSync(file)) return { from: null, convertible: false, plan, warnings: ["no oas-lock.json at this scope"] };
  // ONE strict parser: malformed roots/maps, and the unsupported transitional
  // package-root shape, are typed invalid-lock BEFORE any field is read.
  const strict = parseLockFileStrict(file);
  if (strict.version === LOCKFILE_VERSION) {
    return { from: LOCKFILE_VERSION, convertible: false, plan, warnings: ["already a capability-materialization lock — nothing to migrate"] };
  }
  const catalog = opts.catalog || defaultCatalogResolve;
  const entries = Object.entries(strict.legacyCapabilities);
  // Empty v1: trivially convertible — the dry run reports the FORMAT flip rather
  // than "nothing found" (maintainer ruling). It is never converted implicitly.
  if (!entries.length) {
    plan.push({ capabilityId: null, v1: null, package: null, action: "convert-format", note: `empty lockfileVersion 1 → canonical { lockfileVersion: ${LOCKFILE_VERSION}, packages: {}, capabilities: {} }` });
    return { from: 1, convertible: true, plan, warnings };
  }
  const official = !!opts.official;
  const aliases = official ? (opts.aliases || officialCapabilityAliases()) : undefined;
  for (const [capId, v1] of entries) {
    // Retirement wins before entry-shape validation, matching the central parser
    // and restore/doctor behavior. Never dereference a malformed entry.
    const retiredReason = retiredCapabilityReason(capId);
    if (retiredReason) { plan.push({ capabilityId: capId, v1, package: null, action: official ? "retain" : "manual" }); warnings.push(`${capId}: retired — ${retiredReason}`); continue; }
    const src = v1.source; // validated string by the central parser
    if (src.startsWith("marketplace:")) {
      const id = src.slice("marketplace:".length).replace(/@[^@]*$/, "");
      if (official) {
        // Guided upgrade: the catalog decides which package supplies this legacy
        // capability and at which ref. No version selector is derived from the
        // v1 entry — the v1 capability version names a different artifact than
        // the package that now exports it.
        const m = officialCapabilityPackage(capId, { catalog, aliases });
        const pkg = { id: m.package, source: src, spec: m.package, via: m.via, legacyId: id };
        if (m.available) plan.push({ capabilityId: capId, v1, package: pkg, action: "acquire" });
        else {
          plan.push({ capabilityId: capId, v1, package: pkg, action: "hold", reason: `the official package catalog does not resolve "${m.package}"${m.via === "alias" ? ` (alias of ${capId})` : ""} yet` });
          warnings.push(`${capId}: official package "${m.package}" is not in the package catalog yet — this scope is held, nothing is converted`);
        }
        continue;
      }
      const selector = v1.version ? `v${v1.version}` : undefined;
      const spec = selector ? `${id}@${selector}` : id;
      if (catalog(id, selector)) plan.push({ capabilityId: capId, v1, package: { id, source: src, spec }, action: "acquire" });
      else {
        plan.push({ capabilityId: capId, v1, package: { id, source: src, spec }, action: "manual", reason: `the official package catalog does not resolve "${id}" yet` });
        warnings.push(`${capId}: official package "${id}" is not in the package catalog yet — this scope stays lockfileVersion 1 until it can be mapped`);
      }
    } else if (official) {
      // Custom (git/path) and unknown sources are NOT the guided upgrade's
      // business: they are kept byte-identical.
      plan.push({ capabilityId: capId, v1, package: null, action: "retain" });
      warnings.push(`${capId}: not an official capability (${src}) — kept unchanged; \`oas migrate\` without --official maps custom sources`);
    } else if (src.startsWith("git:")) {
      const url = src.slice(4);
      // A v1 lock has no package-path concept: its artifact WAS the repository
      // root, so the faithful translation selects the root explicitly rather
      // than inheriting the new default contained path.
      const spec = `${v1.commit ? `${url}@${v1.commit}` : url}#.`;
      if (!v1.commit) warnings.push(`${capId}: v1 lock has no commit — the migration acquire will resolve and pin the source's current state`);
      plan.push({ capabilityId: capId, v1, package: { id: null, source: src, spec }, action: "acquire" });
    } else if (src.startsWith("path:")) {
      plan.push({ capabilityId: capId, v1, package: { id: null, source: src, spec: src.slice(5) }, action: "acquire" });
    } else {
      plan.push({ capabilityId: capId, v1, package: null, action: "manual", reason: `unknown v1 source "${src}"` });
      warnings.push(`${capId}: unknown v1 source "${src}" — migrate manually`);
    }
  }
  // ALL-OR-NOTHING, and `retain` blocks with everything else. A revised-v2 lock
  // has {packages, capabilities} and NO residue container, so a retained v1
  // entry has nowhere to live: converting the mappable entries around it would
  // silently drop it and leave the scope unresolvable while its artifact is
  // still on disk. A scope either converts completely or stays exactly as it is.
  const blocking = plan.filter((p) => p.action === "hold" || p.action === "manual" || p.action === "retain");
  return { from: 1, convertible: !blocking.length && plan.some((p) => p.action === "acquire"), plan, warnings };
}

/** Apply that plan at one scope: acquire each mapped package (which materializes
 * its capabilities), then flip the lock. Transactional and ALL-OR-NOTHING —
 * there is no residue container, so a scope either converts completely or stays
 * exactly as it was.
 *
 * Executable approvals are NOT carried over: a v1 capability artifact and a
 * materialized artifact are different bytes, so trust is re-earned and the
 * returned `trust[]` names every executable surface to re-approve.
 *
 * With `opts.official` (the guided existing-user upgrade) a legacy official
 * capability the catalog cannot map throws `official-mapping-unavailable`
 * before any write; a scope with no official work returns `skipped` with its
 * lock untouched and its v1 entries listed in `retained`; and a MIXED scope —
 * official work beside custom/vendored entries that must stay v1 — is refused
 * `legacy-lock` before any write, because there is nowhere for those entries to
 * live in a converted lock. */
export function applyLegacyLockMigration(levelDir, opts = {}) {
  const file = join(levelDir, OAS_LOCK_FILE);
  if (!existsSync(file)) throw oasError("legacy-lock", `no ${OAS_LOCK_FILE} at ${levelDir}`);
  const original = readFileSync(file, "utf8");
  const strict = parseLockFileStrict(file); // raises invalid-lock (incl. unsupported transitional v2)
  if (strict.version === LOCKFILE_VERSION) return { from: LOCKFILE_VERSION, migrated: [], warnings: ["already a capability-materialization lock"], file, trust: [] };
  // ONE plan computation, BEFORE ANY write: it is what lets a held or
  // nothing-to-do scope return with the original lock still untouched.
  const { plan, warnings } = migrateLegacyLock(levelDir, opts);
  const held = plan.filter((s) => s.action === "hold");
  if (held.length) {
    throw oasError("official-mapping-unavailable",
      `${file}: guided official migration is not available yet — ${held.map((s) => `${s.capabilityId} (${s.reason})`).join("; ")}; this scope was left unchanged and its legacy capabilities keep working`,
      held.map((s) => ({ file, capability: s.capabilityId, package: s.package?.id || null })));
  }
  const manual = plan.filter((s) => s.action === "manual");
  if (manual.length) {
    // No residue container: converting the mappable entries would silently drop
    // the rest, so the scope stays v1 in full and keeps working.
    throw oasError("legacy-lock",
      `${file}: this scope cannot be converted yet — ${manual.map((s) => `${s.capabilityId}${s.reason ? ` (${s.reason})` : ""}`).join("; ")}. It was left unchanged and its v1 capabilities keep working; re-run \`oas migrate --dir ${levelDir}\` once they can be mapped.`,
      manual.map((s) => ({ file, capability: s.capabilityId })));
  }
  const retained = plan.filter((s) => s.action === "retain");
  if (opts.official && !plan.some((s) => s.action === "acquire" || s.action === "convert-format")) {
    // Nothing official to convert here: a scope of custom/unknown entries is left
    // exactly as it is — the guided command never rewrites a lock it has no
    // official work in.
    return { from: 1, migrated: [], retained: retained.map((s) => s.capabilityId).filter(Boolean), warnings, file, trust: [], skipped: true };
  }
  if (retained.length) {
    // MIXED SCOPE. Official work beside entries that must stay v1, and no
    // residue container to put them in: converting the official ones would drop
    // these rows while their artifacts remain on disk, so the scope stops
    // resolving and nothing about the tree looks wrong. Refuse the whole scope,
    // before any lock, artifact or ignore mutation.
    const ids = retained.map((s) => s.capabilityId);
    const mappable = retained.every((s) => { const src = s.v1?.source || ""; return src.startsWith("git:") || src.startsWith("path:"); });
    throw oasError("legacy-lock",
      `${file}: this scope mixes official capabilities with entries the guided upgrade keeps unchanged — ${retained.map((s) => `${s.capabilityId} (${s.v1?.source || "unknown source"})`).join("; ")}. A capability-materialization lock has no place for them, so converting the official ones would drop them. NOTHING was changed and the whole v1 scope stays usable.${mappable ? ` Every retained source is package-mappable, so \`oas migrate --dir ${levelDir}\` (without --official) can convert this scope completely.` : ""}`,
      ids.map((capability) => ({ file, capability })));
  }
  if (plan.length === 1 && plan[0].action === "convert-format") {
    const ignore = ensureInstalledGitignorePreflight(levelDir);
    try {
      atomicWriteFileSync(file, JSON.stringify({ lockfileVersion: LOCKFILE_VERSION, packages: {}, capabilities: {} }, null, 2) + "\n");
    } catch (e) { ignore.rollback(); throw e; }
    return { from: 1, migrated: [], warnings, file, trust: [], formatConverted: true };
  }
  // Flip the version so acquirePackage accepts the scope, convert every entry,
  // and on ANY failure restore the original v1 lock byte-identically and remove
  // every artifact this migration created. Superseded v1 artifacts are deleted
  // only after full success.
  const ignore = ensureInstalledGitignorePreflight(levelDir);
  atomicWriteFileSync(file, JSON.stringify({ lockfileVersion: LOCKFILE_VERSION, packages: {}, capabilities: {} }, null, 2) + "\n");
  const migrated = [];
  const createdDirs = [];
  const acquired = new Map(); // package id → { package, capabilities }
  const removedCapDirs = []; // deferred: v1 artifacts are deleted only after full success
  // ONE package may supply SEVERAL migrated capabilities (catalog aliases can
  // map many legacy ids onto one package, as oas.dev does), so each distinct
  // source is acquired exactly once (reviewer-90dbb36).
  const groups = [];
  const bySpec = new Map();
  for (const step of plan) {
    if (step.action !== "acquire") continue;
    if (!bySpec.has(step.package.spec)) { const g = { spec: step.package.spec, steps: [] }; bySpec.set(step.package.spec, g); groups.push(g); }
    bySpec.get(step.package.spec).steps.push(step);
  }
  try {
    for (const g of groups) {
      const r = acquirePackage(levelDir, g.spec, opts);
      // Record EVERY artifact this conversion created BEFORE validating the
      // providers — a failing validation must roll back the failing package's
      // closure too, not only earlier conversions.
      for (const c of r.capabilities) createdDirs.push(c.dir);
      for (const p of r.installed) acquired.set(p.package, { package: p.package, capabilities: p.capabilities });
      for (const step of g.steps) {
        const provider = r.installed.find((p) => p.capabilities.includes(step.capabilityId));
        if (!provider) throw oasError("capability-list-mismatch", `migrated source ${g.spec} does not export capability "${step.capabilityId}"`);
        migrated.push({ capability: step.capabilityId, package: provider.package, version: provider.version });
      }
      // The v1 artifact for a converted capability is superseded by the
      // materialized one at the SAME path, so acquisition already replaced it;
      // nothing extra to delete. Any OTHER v1 artifact directory whose oas.json
      // claims a converted id is stale and is cleaned after full success.
      const capStore = installedCapabilitiesDir(levelDir);
      if (existsSync(capStore)) {
        for (const e of readdirSync(capStore, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          const cdir = join(capStore, e.name);
          if (r.capabilities.some((c) => c.dir === cdir)) continue;
          try { if (g.steps.some((s) => s.capabilityId === JSON.parse(readFileSync(join(cdir, "oas.json"), "utf8")).capability)) removedCapDirs.push(cdir); }
          catch { /* not a capability dir */ }
        }
      }
    }
  } catch (e) {
    // Roll back: original v1 lock byte-identical, migration artifacts removed,
    // ignore bytes restored.
    writeFileSync(file, original);
    for (const d of createdDirs) rmSync(d, { recursive: true, force: true });
    ignore.rollback();
    throw oasError(e.code || "legacy-lock", `migration failed and was rolled back (original v1 lock restored): ${e.message}`, e.provenance);
  }
  for (const d of removedCapDirs) rmSync(d, { recursive: true, force: true });
  // Executable surfaces that must be re-earned (approvals are never carried
  // over). Post-commit convenience: a failure here must not undo a completed
  // migration, so it degrades to a warning.
  const trust = [];
  try {
    const rows = levelLockRows(levelDir).capabilities;
    for (const p of acquired.values()) {
      for (const cid of p.capabilities) {
        if (!Object.hasOwn(rows, cid)) continue;
        const manifest = loadManifestAt(installedCapabilityDir(levelDir, cid), `installed:${levelDir}`);
        if (hasExecutableSurface(manifest)) trust.push({ capability: cid, package: p.package, level: levelDir });
      }
    }
  } catch (e) { warnings.push(`could not enumerate executable surfaces to re-trust: ${e.message} — run \`oas doctor\` to list them`); }
  return { from: 1, migrated, warnings, file, trust };
}

/** Unmet external requirements of a capability. */
export function capabilityMissingRequires(name, startDir) {
  const m = capabilityManifest(name, startDir);
  return (m?.requires || []).filter((r) => r.command && !which(r.command));
}

/** The canonical kernel-marketplace directory an installed marketplace capability's
 * framework-hoisted paths are declared against — `<PKG_ROOT>/capabilities/<slug>`,
 * found by CAPABILITY IDENTITY (the lock selector's slug is not authoritative).
 * The shipped source must still be the same capability at the same version as the
 * installed/locked copy; a drifted kernel fails closed instead of silently anchoring
 * an old install onto new framework content. Returns undefined when this kernel does
 * not ship the capability at all — the resource then simply does not resolve, which
 * spawn preflight reports as a missing declared resource. */
function marketplaceAnchorDir(manifest) {
  const lock = manifest._marketplaceLock;
  if (!lock) return undefined;
  const canonical = marketplaceCapabilities()[manifest.capability];
  if (!canonical || canonical.capability !== manifest.capability) return undefined;
  const level = String(manifest._origin).startsWith("installed:") ? String(manifest._origin).slice("installed:".length) : undefined;
  // A kernel upgrade is itself the trusted update boundary for framework-hoisted
  // resources, so the canonical marketplace version may legitimately be newer
  // than an older installed v1 copy (0.18.6 aweb@1.5.1 → 0.19 aweb@1.8.0).
  // The installed COPY and its LOCK must still agree; that is the drift this
  // compatibility seam can diagnose and recover.
  const drift = lock.version !== undefined && lock.version !== manifest.version
    ? `lock pins ${lock.version}, installed copy is ${manifest.version}`
    : undefined;
  if (drift) {
    // Name the sequence that actually relocks. A bare `oas install <id>` finds
    // the existing copy and stops at "Already acquired ... not activated or
    // updated", and legacy v1 capability entries are not removable with
    // `oas remove` (packages only), so the copy must go first: explicit install
    // then re-acquires AND overwrites the lock entry.
    throw oasError("E_MARKETPLACE_SOURCE_DRIFT", `capability ${manifest.capability} declares framework-hoisted resources, but its installed copy and lock disagree (${drift}). Reacquire it — delete the installed copy at ${manifest._dir}, then run \`oas install ${manifest.capability}${level ? ` --dir ${level}` : ""}\` (with the copy still present that command reports "Already acquired" and changes nothing) — or deselect the capability for this soul.`);
  }
  return canonical._dir;
}
/** Resolve a manifest-relative path; only marketplace-sourced packages may use framework-hoisted resources. */
function manifestPath(manifest, rel) {
  const local = join(manifest._dir, rel);
  if (existsSync(local)) {
    // A materialized capability artifact IS its own containment boundary; a
    // legacy standalone capability likewise. There is no wider package root.
    const root = realpathSync(manifest._dir); const target = realpathSync(local); const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`capability ${manifest.capability} path escapes its integrity boundary: ${rel}`);
    }
    return local;
  }
  // Only marketplace (framework-shipped) packages may intentionally use hoisted/shared
  // framework resources, and the declaration is written against the capability's
  // directory in the marketplace — NOT against the kernel package root, which is two
  // levels up from it and resolves `../../skills/...` outside the kernel entirely.
  if (manifest._marketplace) {
    const anchor = marketplaceAnchorDir(manifest);
    if (!anchor) return undefined;
    // Declarations are capability-directory-relative. npm may nevertheless
    // hoist a capability's dependency to the kernel root (the published
    // oas.aweb package.json depends on @awebai/pi while npm installs it under
    // <kernel>/node_modules), so use that root-hoisted spelling only when the
    // canonical declaration path does not exist. Both candidates remain inside
    // the explicitly installed kernel trust boundary.
    const candidates = [join(anchor, rel), join(REPO_ROOT, rel)];
    const kernel = realpathSync(REPO_ROOT);
    for (const hoisted of candidates) {
      if (!existsSync(hoisted)) continue;
      const fromKernel = relative(kernel, realpathSync(hoisted));
      if (fromKernel === ".." || fromKernel.startsWith(`..${sep}`) || isAbsolute(fromKernel)) {
        throw new Error(`capability ${manifest.capability} path escapes its integrity boundary: ${rel}`);
      }
      return hoisted;
    }
    return undefined;
  }
  return undefined;
}
/** Resolve an executable declared by a manifest through the same artifact boundary as hooks. */
export function capabilityExecutablePath(manifest, rel) { return manifestPath(manifest, rel); }
function assertCapabilityTreeContained(manifest, tree, resource = "skill") {
  const manifestRoot = realpathSync(manifest._dir);
  const treeReal = realpathSync(tree);
  const fromManifest = relative(manifestRoot, treeReal);
  const outsideCopy = fromManifest === ".." || fromManifest.startsWith(`..${sep}`) || isAbsolute(fromManifest);
  // Marketplace-sourced installs may reference framework-hoisted trees that live
  // outside the installed copy — but the kernel package is still a boundary, so
  // such a tree is walked against PKG_ROOT rather than exempted from the walk.
  const artifact = manifest._marketplace && outsideCopy ? realpathSync(REPO_ROOT) : realpathSync(manifest._dir);
  const visited = new Set();
  const assertInside = (target, path) => {
    const fromArtifact = relative(artifact, target);
    if (fromArtifact === ".." || fromArtifact.startsWith(`..${sep}`) || isAbsolute(fromArtifact)) {
      throw new Error(`capability ${manifest.capability} ${resource} path escapes its integrity boundary: ${relative(manifest._dir, path)}`);
    }
  };
  const walk = (dir) => {
    const realDir = realpathSync(dir);
    assertInside(realDir, dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const target = realpathSync(path); // also rejects broken symlinks
      assertInside(target, path);
      if (entry.isSymbolicLink()) {
        // Recurse through contained directory links: descendants may carry a
        // second symlink that escapes the package boundary.
        if (lstatSync(target).isDirectory()) walk(target);
      } else if (entry.isDirectory()) walk(path);
    }
  };
  walk(tree);
}
/** Every skill tree a capability DECLARES, paired with where it resolved (or
 * undefined when it did not resolve at all). The declared list is what makes a
 * missing resource detectable: `capabilitySkillDirs` drops unresolved entries,
 * which is how a capability could contribute zero skills while its injection
 * still told the agent to load them. Preflight consumes this; resolved-only
 * consumers keep using capabilitySkillDirs. */
export function capabilityDeclaredSkills(name, startDir) {
  const m = capabilityManifest(name, startDir);
  if (!m?.skills) return [];
  return m.skills.map((declared) => {
    const path = manifestPath(m, declared);
    if (path) assertCapabilityTreeContained(m, path);
    return { declared, path };
  });
}
export function capabilitySkillDirs(name, startDir) {
  return capabilityDeclaredSkills(name, startDir).filter((s) => s.path).map((s) => s.path);
}
/** Packaged default injection for a capability or work mode (undefined if none shipped). */
export function packagedInject(name, startDir) {
  const m = capabilityManifest(name, startDir);
  if (m?.inject) { const p = manifestPath(m, m.inject); if (p) return p; }
  const p = join(PACKAGED_INJECTS_DIR, `${name}.md`);
  return existsSync(p) ? p : undefined;
}
/** A capability's instruction injection, with config override:
 * `injection-override: <path>|none|default` on its config entry (closest scope wins). */
function capabilityInject(id, startDir) {
  for (const cfg of configChain(startDir)) {
    for (const { id: entryId, spec } of configCapabilityEntries(cfg)) {
      if (entryId !== id || spec["injection-override"] === undefined) continue;
      return resolveInjectValue(spec["injection-override"], cfg._level, () => packagedInject(id, startDir));
    }
  }
  return packagedInject(id, startDir);
}
/** injection value → absolute file: absent/"default" → packaged default, "none" → off, else path. */
function resolveInjectValue(val, level, fallback) {
  if (val === undefined || val === "" || val === "default") return fallback();
  if (val === "none") return undefined;
  return isAbsolute(val) ? val : join(level, val);
}

/** Work-mode config for a context: { inject, setup }. The briefing is always the
 * packaged one (work-mode injection overrides were removed); setup is an optional
 * env-bootstrap script run inside each new worktree after creation. */
export function resolveWorkMode(contextDir, mode) {
  const chain = configChain(contextDir);
  const inject = packagedInject(`work-${mode}`);
  for (const cfg of chain) {
    const wm = cfg["work-modes"]?.[mode];
    if (!wm || typeof wm !== "object" || !wm.setup) continue;
    const setup = isAbsolute(wm.setup) ? wm.setup : join(cfg._level, wm.setup);
    return { inject, setup };
  }
  return { inject, setup: undefined };
}

/** Is this dir inside an OAS workspace? True when a config exists BELOW the laptop
 *  level (a workspace like ~/lfx or a repo with its own oas-config), or when a
 *  REAL agents root is reachable (one containing at least one soul — a dir merely
 *  named "agents" does not qualify). The laptop-level config alone does not: it
 *  holds machine defaults, it does not make every directory an agent workspace. */
export function isOasWorkspace(startDir) {
  const home = process.env.HOME || "";
  if (configChain(startDir).some((c) => c._level !== home)) return true;
  const root = findRoot(startDir);
  if (!root) return false;
  try {
    // Local souls beside the root count — a scope can be all-local.
    const localBase = localAgentsDirOf(root);
    if (existsSync(localBase)) {
      for (const t of readdirSync(localBase, { withFileTypes: true })) {
        if (t.isDirectory() && existsSync(join(localBase, t.name, "soul"))) return true;
      }
    }
    if (!existsSync(root)) return false;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === LOCAL_AGENTS_DIR || LEGACY_LOCAL_DIRS.includes(e.name)) {
        for (const t of readdirSync(join(root, e.name), { withFileTypes: true })) {
          if (t.isDirectory() && existsSync(join(root, e.name, t.name, "soul"))) return true;
        }
      } else if (existsSync(join(root, e.name, "soul"))) return true;
    }
  } catch { /* unreadable root */ }
  return false;
}

/** Compose, but never mutate, an instance instruction view from canonical soul instructions.
 * `kind` tunes composition: "local" adds the packaged local-soul briefing;
 * "capability" suppresses the knowledge layer's injection (ephemeral service
 * agents — reviewers, harvesters — carry no episodic memory by design). */
export function composeInstanceAgentsMd(soulDir, contextDir, soulName, workMode, kind) {
  const agentsMd = join(soulDir, "AGENTS.md");
  if (!existsSync(agentsMd)) throw new Error(`canonical soul instructions missing: ${agentsMd}`);
  const resolved = resolveOasConfig(contextDir, soulName);
  const wanted = [];
  const kernelInject = resolved.kernelInjection?.inject;
  if (kernelInject && existsSync(kernelInject)) wanted.push(["kernel:oas", kernelInject]);
  if (kind === "local") {
    const localInject = packagedInject("local-soul");
    if (localInject) wanted.push(["kernel:local-soul", localInject]);
  }
  // The home/work boundary is runtime-neutral and mode-independent: every
  // instance — including capability service agents in attached mode — needs to
  // know which directory is its brain and which is the repository, and where
  // `aw`/`oas` resolve their scope from. It precedes the mode block, which then
  // adds only that mode's ownership and branch rules.
  const boundaryInject = packagedInject("instance-boundary");
  if (boundaryInject && existsSync(boundaryInject)) wanted.push(["kernel:instance-boundary", boundaryInject]);
  const wm = resolveWorkMode(contextDir, workMode || "checkout");
  if (wm.inject && existsSync(wm.inject)) wanted.push([`work-mode:${workMode || "checkout"}`, wm.inject]);
  for (const cap of resolved.capabilities) {
    if (kind === "capability" && cap.layer === "knowledge") continue; // ephemeral: no memory protocol
    if (cap.inject && existsSync(cap.inject)) wanted.push([`capability:${cap.id}`, cap.inject]);
  }
  for (const inj of resolved.injects) wanted.push([`config:${inj.source}`, inj.file]);
  let text = readFileSync(agentsMd, "utf8").replace(/\n*$/, "\n");
  const blocks = [];
  for (const [source, file] of wanted) {
    const content = readFileSync(file, "utf8").trim();
    const block = `<!-- oas:${source} src=${file} -->\n${content}\n<!-- /oas:${source} -->`;
    text += `\n${block}\n`;
    blocks.push({ source, file, content });
  }
  return { text, blocks, resolved };
}

/** The skill entries a tree contributes — THE discovery rule, shared by preflight
 * and materialization so the two can never disagree about what a tree provides.
 *
 * Note `e.isDirectory()` is false for a symlinked child (readdir uses lstat
 * semantics), so a skill directory represented by a symlink contributes nothing.
 * That is deliberate and matches what actually gets copied; preflight reporting
 * such a tree as empty is the point, not a gap. */
function skillEntriesIn(tree) {
  if (!tree || !existsSync(tree)) return [];
  if (hasSkillDoc(tree)) return [{ name: basename(tree), src: tree }];
  const out = [];
  for (const e of readdirSync(tree, { withFileTypes: true })) {
    if (e.isDirectory() && hasSkillDoc(join(tree, e.name))) out.push({ name: e.name, src: join(tree, e.name) });
  }
  return out;
}
/** Does this directory hold a READABLE skill document? `existsSync` is true for
 * a DIRECTORY named SKILL.md, which would let a tree pass every check and still
 * launch an instance with no readable skill (reviewer-d70bc8b). The marker must
 * be a regular file. */
function hasSkillDoc(dir) {
  try { return statSync(join(dir, "SKILL.md")).isFile(); } catch { return false; }
}

/** Enumerate every resource the resolved composition PROMISES this instance,
 * and refuse the spawn if any declared resource did not resolve.
 *
 * The kernel used to fail closed on a missing capability MANIFEST but open on a
 * missing capability RESOURCE: `capabilitySkillDirs()` dropped unresolved paths,
 * the materialization loop skipped non-existent sources, and
 * `composeInstanceAgentsMd()` omitted missing injections. A capability could
 * therefore contribute zero skills while its injection still instructed the
 * agent to load them — observed with oas.aweb in a worktree without its
 * dependencies installed.
 *
 * Preflight runs BEFORE the instance home exists, which is the cheapest possible
 * transaction boundary: the most common failure needs no rollback at all.
 * Installed-but-inactive capabilities are absent from `resolved.capabilities`
 * and so contribute nothing here, by construction.
 */
export function planInstanceResources({ resolved, soulDir, agent, contextDir, composition }) {
  const expected = [];
  const missing = [];
  /** `declares` marks a tree the manifest PROMISED: it must resolve AND yield at
   * least one discoverable skill. A directory that merely happens to exist (a
   * soul's optional skills/) promises nothing, so an empty one is not a defect. */
  const add = (r, { declares = true } = {}) => {
    if (r.type === "skill-tree") r.entries = skillEntriesIn(r.path).map((e) => e.name);
    expected.push(r);
    if (!r.path) missing.push({ ...r, reason: "did not resolve" });
    else if (declares && r.type === "skill-tree" && !r.entries.length) {
      missing.push({ ...r, reason: `resolved to ${r.path} but contains no skill (no SKILL.md, and no child directory with one — a symlinked skill directory does not count)` });
    }
  };

  for (const path of [join(PACKAGED_SKILLS_DIR, "oas"), join(PACKAGED_SKILLS_DIR, "oas-config"), join(PACKAGED_SKILLS_DIR, "oas-packages")]) {
    add({ type: "skill-tree", source: "kernel", declared: basename(path), path: existsSync(path) ? path : undefined });
  }
  const soulSkills = soulDir && join(soulDir, "skills");
  // A soul with no skills/ dir declares nothing — nor does an empty one.
  if (soulSkills && existsSync(soulSkills)) add({ type: "skill-tree", source: "soul", declared: soulSkills, path: soulSkills }, { declares: false });

  for (const cap of resolved.capabilities || []) {
    for (const s of cap.skillsDeclared || []) {
      add({ type: "skill-tree", source: cap.id, declared: s.declared, path: s.path, origin: cap.origin, level: cap.level });
    }
    // Capability agents are ephemeral and deliberately get no memory protocol,
    // so composeInstanceAgentsMd drops knowledge-layer injections for them.
    // The expected set MUST apply the same rule or it reports an intentional
    // omission as an incomplete composition. (Coupled to the matching `continue`
    // in composeInstanceAgentsMd — change both together.)
    const intentionallyDropped = agent?.kind === "capability" && cap.layer === "knowledge";
    if (intentionallyDropped) continue;
    // A capability that declares `inject:` must produce it. An explicit
    // `injection-override: none` resolves to no injection and declares nothing,
    // so it is not a miss.
    if (cap.injectDeclared && cap.inject === undefined && !injectionDisabledFor(cap.id, contextDir)) {
      add({ type: "injection", source: cap.id, declared: cap.injectDeclared, path: undefined, origin: cap.origin, level: cap.level });
    } else if (cap.inject) {
      add({ type: "injection", source: cap.id, declared: cap.injectDeclared || basename(cap.inject), path: existsSync(cap.inject) ? cap.inject : undefined, origin: cap.origin, level: cap.level });
    }
  }
  // A capability-defined agent always carries its own capability's skills,
  // regardless of config targeting, so they are expected for it too.
  if (agent?.kind === "capability" && agent.capability && !(resolved.capabilities || []).some((c) => c.id === agent.capability)) {
    for (const s of capabilityDeclaredSkills(agent.capability, contextDir)) {
      add({ type: "skill-tree", source: agent.capability, declared: s.declared, path: s.path });
    }
  }
  if (composition) {
    for (const b of composition.blocks || []) expected.push({ type: "instruction-block", source: b.source, declared: b.file, path: b.file });
  }

  // A capability that declares a REQUIRED hook it cannot execute must not spawn.
  // Advisory executable hooks stay disabled-with-warning; a required one is a
  // promise, and starting without it is the failure required:true exists to stop.
  const untrusted = [];
  for (const cap of resolved.capabilities || []) {
    if (!(cap.requiredHooks || []).length || cap.trust?.trusted) continue;
    untrusted.push(`  ${cap.id} declares required hook(s) ${cap.requiredHooks.join(", ")}, but its executable surface is not trusted${cap.trust?.reason ? ` (${cap.trust.reason})` : ""} — run \`oas trust ${cap.id}${contextDir ? ` --dir ${contextDir}` : ""}\``);
  }
  if (untrusted.length) {
    throw oasError("E_REQUIRED_HOOK_UNTRUSTED", `this soul activates capabilities whose required setup cannot run:\n${untrusted.join("\n")}\n\nA required hook is a promise the instance's instructions rely on, so OAS will not start without it.`);
  }

  if (missing.length) {
    const detail = missing.map((m) => `  ${m.type} "${m.declared}" declared by ${m.source}${m.origin ? ` (${m.origin})` : ""} ${m.reason}`).join("\n");
    throw oasError("E_CAPABILITY_RESOURCE_MISSING", `the resolved composition declares ${missing.length} resource(s) that do not exist, so this instance would start without them while its instructions still refer to them:\n${detail}\n\nResources must come from the capability's locked/materialized package content — a path that only exists after an ad-hoc dependency install is a manifest defect. Fix the capability or deselect it for this soul.`);
  }
  return expected;
}
/** Did config explicitly turn a capability's injection off (`injection-override: none`)? */
function injectionDisabledFor(id, startDir) {
  for (const cfg of configChain(startDir)) {
    for (const { id: entryId, spec } of configCapabilityEntries(cfg)) {
      if (entryId === id && spec["injection-override"] !== undefined) return spec["injection-override"] === "none";
    }
  }
  return false;
}

// ---------- runtime packages (satisfied by a runtime's own package manager) ----------

/** pi's config dir, officially relocatable via PI_CODING_AGENT_DIR (pi
 * docs/usage.md). Hard-coding ~/.pi/agent reports an installed package as
 * missing on a relocated host, and then reports a consented install as failed
 * (reviewer-ee6592c). PI_PACKAGE_DIR is deliberately NOT used: it points at pi's
 * own package assets, not at `pi install` output, so treating it as the user
 * package root sends lookups to the wrong tree (reviewer-ad1b9f0). */
const piAgentDir = (env = process.env) => env.PI_CODING_AGENT_DIR || join(env.HOME || "", ".pi", "agent");

/** Runtimes whose own package manager can satisfy a requirement. A runtime
 * package is NOT a command on PATH: it is registered with the runtime, so both
 * detection and post-install verification read that runtime's package list. */
export const RUNTIME_PACKAGE_MANAGERS = {
  pi: {
    scope: "user-level (pi packages)",
    identity: (spec) => packageSpecIdentity(spec),
    safeSpec: (spec) => typeof spec === "string" && /^[a-z][a-z0-9+.-]*:(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~><=-]+)?$/i.test(spec),
    argv: (spec) => ["pi", "install", spec],
    /** Installed packages as PI reports them. `pi list` is pi's own resolver
     * answer — spec, the resolved install directory, and whether the entry
     * filters the package's resources — so OAS never has to guess at package
     * roots. `--no-approve` keeps a spawn-time probe from trusting
     * project-local files. Falls back to reading settings when pi cannot be
     * run, which yields presence without a verified directory. */
    list: (env = process.env) => {
      try {
        const out = execFileSync("pi", ["list", "--no-approve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 30000 });
        const rows = [];
        // pi dims the path with chalk; strip any escapes before matching.
        const lines = out.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = /^ {2}(\S+)(\s+\(filtered\))?\s*$/.exec(lines[i]);
          if (!m) continue;
          // pi prints the install path ONLY when the package is actually
          // installed (`if (pkg.installedPath)` in its list command), so an
          // absent path line is the signal for configured-but-not-installed —
          // not a parsing gap (reviewer-6ad0dde).
          const dir = /^ {4,}(\S.*)$/.exec(lines[i + 1] || "");
          rows.push({ source: m[1], filtered: !!m[2], dir: dir ? dir[1].trim() : undefined });
        }
        return rows;
      } catch {
        // pi could not be run. Settings tell us what was CONFIGURED, never what
        // is installed, so every row is marked unverified and the caller fails
        // closed rather than trusting a config file (reviewer-6ad0dde).
        const file = join(piAgentDir(env), "settings.json");
        if (!existsSync(file)) return [];
        try {
          const cfg = JSON.parse(readFileSync(file, "utf8"));
          return (Array.isArray(cfg.packages) ? cfg.packages : [])
            .map((p) => (typeof p === "string" ? { source: p } : p && typeof p === "object" && typeof p.source === "string" ? { source: p.source } : undefined))
            .filter(Boolean)
            .map((r) => ({ ...r, unverified: "could not run `pi list`" }));
        } catch { return []; } // unreadable settings: "not installed", never a false positive
      }
    },
    /** The entry's explicit `extensions` filter, if any.
     *
     * pi accepts `{ source, extensions: [...] }`, which selects WHICH of the
     * package's extensions load. For a REQUIRED capability package that matters:
     * `[]` loads none, and a non-empty filter may name a wrong or nonexistent
     * path, or simply omit the capability's extension — either way the instance
     * would start claiming wakeable messaging with no channel.
     *
     * OAS must not reimplement pi's glob matcher, which means it CANNOT prove a
     * filtered extension is active. Both cases therefore fail, with different
     * remedies. A filter on other resource kinds (e.g. `skills`) is unrelated
     * and must keep passing — the real oas-aweb entry filters skills only. */
    resourceFilter: (spec, env = process.env) => {
      const file = join(piAgentDir(env), "settings.json");
      if (!existsSync(file)) return undefined;
      try {
        const cfg = JSON.parse(readFileSync(file, "utf8"));
        const want = packageSpecIdentity(spec);
        for (const p of Array.isArray(cfg.packages) ? cfg.packages : []) {
          if (!p || typeof p !== "object" || typeof p.source !== "string") continue;
          if (packageSpecIdentity(p.source) !== want) continue;
          if (!("extensions" in p)) return undefined;
          const list = Array.isArray(p.extensions) ? p.extensions : [];
          return { extensions: list, disabled: list.length === 0 };
        }
      } catch { /* unreadable settings is handled by list() */ }
      return undefined;
    },
  },
  claude: {
    scope: "user-level (Claude Code plugins)",
    /** A plugin id is `name@marketplace`, so "@" separates the SOURCE — stripping
     * it the way a version selector is stripped would collapse plugins from
     * different marketplaces into one identity. */
    identity: (spec) => String(spec || "").trim(),
    safeSpec: (spec) => typeof spec === "string" && /^[a-z0-9][\w.-]*@[a-z0-9][\w.-]*$/i.test(spec),
    /** The executable is CONTEXT-SELECTED (oas-claude-config may name a wrapper
     * such as `claude-personal`). Probing and installing through the literal
     * `claude` would inspect a DIFFERENT account's plugins than the session
     * actually launches with — passing preflight while the real runtime lacks
     * the channel, or rejecting one that has it (reviewer-6f1bb9c). */
    bin: (opts) => opts?.bin || "claude",
    argv: (spec, req, opts) => [RUNTIME_PACKAGE_MANAGERS.claude.bin(opts), "plugin", "install", String(spec)],
    /** A marketplace must be registered before installing from it, so the plan
     * is a SEQUENCE. Both steps are shown at the consent prompt: agreeing to a
     * plugin also means agreeing to the source it comes from. */
    steps: (spec, req, opts) => {
      const bin = RUNTIME_PACKAGE_MANAGERS.claude.bin(opts);
      return [
        ...(req?.marketplace ? [[bin, "plugin", "marketplace", "add", String(req.marketplace)]] : []),
        [bin, "plugin", "install", String(spec)],
      ];
    },
    /** Claude's own structured answer. `--json` carries id, scope, enabled,
     * projectPath and installPath — human output loses scope, and a plugin
     * installed for an UNRELATED project would then satisfy the requirement
     * globally (frontend-design is installed project-scoped for two different
     * projects on this machine). */
    list: (env = process.env, opts = {}) => {
      let out;
      try {
        out = execFileSync(RUNTIME_PACKAGE_MANAGERS.claude.bin(opts), ["plugin", "list", "--json"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000, env });
      } catch { return []; }
      let rows;
      try { rows = JSON.parse(out); } catch { return []; }
      if (!Array.isArray(rows)) return [];
      const target = opts.context ? realPathOrNearest(opts.context) : undefined;
      return rows
        .filter((r) => r && typeof r.id === "string")
        // A user-scope install applies everywhere. A project/local install
        // applies only inside the project it belongs to.
        .filter((r) => {
          if (r.scope === "user") return true;
          if (!r.projectPath || !target) return false;
          const owner = realPathOrNearest(r.projectPath);
          return target === owner || target.startsWith(owner + sep);
        })
        // verifiedPresent is the "this runtime confirms presence without naming a
        // location" override, NOT a blanket exemption: Claude DOES report
        // installPath, and setting it unconditionally meant a stale registration
        // whose install directory had been deleted still satisfied the spawn
        // preflight (reviewer-aggregate2). Claim it only when there is no path
        // to check.
        .map((r) => ({ source: r.id, enabled: r.enabled !== false, scope: r.scope, projectPath: r.projectPath, dir: r.installPath, verifiedPresent: !r.installPath }));
    },
  },
};

/** A package spec without its version selector, so `npm:@awebai/pi@latest`,
 * `npm:@awebai/pi@0.2.1` and `npm:@awebai/pi` are ONE identity. Scoped names
 * keep their leading "@" — the selector separator is the LAST "@", not the first. */
export function packageSpecIdentity(spec) {
  const s = String(spec || "").trim();
  const colon = s.indexOf(":");
  const prefix = colon > 0 ? s.slice(0, colon + 1) : "";
  const rest = colon > 0 ? s.slice(colon + 1) : s;
  if (!rest) return s;
  const scoped = rest.startsWith("@");
  const body = scoped ? rest.slice(1) : rest;
  const at = body.indexOf("@");
  return `${prefix}${scoped ? "@" : ""}${at >= 0 ? body.slice(0, at) : body}`;
}

/** What the runtime reports about a required package: is it there, where did it
 * land, and does the user's entry filter its resources? A settings row alone is
 * NOT proof the capability's extension will load (reviewer-8518c49). */
export function runtimePackageStatus(runtime, spec, env = process.env, opts = {}) {
  const mgr = RUNTIME_PACKAGE_MANAGERS[runtime];
  if (!mgr) return { installed: false };
  const want = runtimePackageIdentity(runtime, spec);
  const row = mgr.list(env, opts).find((r) => runtimePackageIdentity(runtime, r.source) === want);
  if (!row) return { installed: false };
  const filter = mgr.resourceFilter ? mgr.resourceFilter(spec, env) : undefined;
  return {
    installed: true,
    source: row.source,
    dir: row.dir,
    unverified: row.unverified,
    // No resolved directory means the package is configured but NOT installed:
    // pi omits the path line entirely in that case, so treating a missing line
    // as "fine" let a stale row through. A named directory that does not exist
    // is the same condition, reported the same way. A runtime that confirms
    // presence without naming a directory (Claude's plugin list) says so via
    // verifiedPresent, so it is not judged by a path it never reports.
    missingFiles: row.verifiedPresent ? false : (!row.dir || !existsSync(row.dir)),
    // Installed but switched off will not load, so it does not satisfy a requirement.
    disabled: row.enabled === false,
    // pi's own "(filtered)" marker covers ANY resource filter (skills included),
    // so it must not be conflated with an extensions filter.
    filtered: row.filtered,
    extensionsFilter: filter ? filter.extensions : undefined,
    extensionsDisabled: !!filter?.disabled,
  };
}
/** The identity of a runtime package, per that runtime's own naming. */
export function runtimePackageIdentity(runtime, spec) {
  const mgr = RUNTIME_PACKAGE_MANAGERS[runtime];
  return mgr?.identity ? mgr.identity(spec) : packageSpecIdentity(spec);
}

/** Is a runtime package actually USABLE — present, with a verified install
 * location? Deliberately ONE predicate rather than a presence check plus a
 * satisfaction check: the two would drift, and every caller means "is it really
 * there". A configured row with no install location, a location that does not
 * exist, or a settings-only answer we could not verify all count as NOT
 * installed, so requirement aggregation still offers to install it and
 * post-install verification cannot report success while it is still missing
 * (reviewer-14c38e8). `runtimePackageStatus` carries the detail for diagnostics. */
export function runtimePackageInstalled(runtime, spec, env = process.env, opts = {}) {
  const st = runtimePackageStatus(runtime, spec, env, opts);
  return !!st.installed && !st.unverified && !st.missingFiles && !st.disabled;
}

/** Gate: a runtime package spec must be a plain source token — no shell syntax,
 * whitespace, path traversal, or option-looking leading dash. Fail closed. */
export function safeRuntimePackageSpec(spec, runtime = "pi") {
  const mgr = RUNTIME_PACKAGE_MANAGERS[runtime];
  return mgr?.safeSpec ? mgr.safeSpec(spec) : false;
}
/** A marketplace/source token a requirement may register before installing.
 * No shell syntax, whitespace, traversal or leading dash — it is passed as argv,
 * but a hostile value would still name an attacker-chosen source. */
export function safeRuntimeSourceRef(ref) {
  return typeof ref === "string" && /^[a-z0-9][\w.-]*(\/[a-z0-9][\w.-]*)*$/i.test(ref);
}

// ---------- capability lifecycle hooks ----------
/**
 * Run a lifecycle event's hooks for every active capability. Env contract:
 * OAS_EVENT/OAS_INSTANCE/OAS_HOME/OAS_AGENT/OAS_CONTEXT/OAS_LEVEL/OAS_SETTINGS/OAS_META,
 * plus OAS_TEAM_NAME/OAS_TEAM_ID/OAS_TEAM_SCOPE when a `team:` block resolves;
 * cwd = the instance home. A hook may print JSON { meta, brief, warning, launch } — meta is
 * persisted per capability in instance.json (and fed back as OAS_META at retire), brief
 * is added to TASK.md, warning surfaces in the spawn result; launch maps runtime → extra
 * launch-command arguments (spawn IS session start: the command built here is stored in
 * instance.json and runs in the tmux window; a capability integrating a runtime — e.g.
 * aweb's Claude Code channel plugin — contributes its flags this way). A hook the
 * capability declares REQUIRED fails the spawn and rolls it back; every other
 * hook failure is advisory and only warns.
 */
export function runLifecycleHooks(event, { home, instance, agentName, soulDir, contextDir, workspaceDir, rootDir, resolved, priorMeta = {}, extraEnv = {} }) {
  const results = { meta: {}, briefs: [], warnings: [], order: [], launch: {}, failures: [] };
  const caps = [...(resolved.capabilities || [])];
  if (event === "retire") caps.reverse();
  for (const cap of caps) {
    for (const miss of cap.missingRequires || []) {
      results.warnings.push(`${cap.id}${cap.layer ? ` (${cap.layer})` : ""}: required command "${miss.command}" not on PATH — ${miss.why || "needed by this capability"}${miss.install ? ` (install: ${miss.install})` : ""}`);
    }
    if (cap.executable && !cap.trust?.trusted) results.warnings.push(`${cap.id}: executable surface disabled — ${cap.trust?.reason || "not trusted"}`);
    const cmd = cap.hooks?.[event];
    if (!cmd) continue;
    results.order.push(cap.id);
    try {
      const stdout = execSync(cmd, {
        cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
        env: {
          ...process.env,
          // OAS_INSTANCE_HOME is the runtime-neutral contract name for the
          // instance home (absolute). OAS_HOME predates it and stays as a
          // compatibility alias: shipped capability hooks read it
          // (capabilities/oas-aweb, capabilities/oas-okf) and are versioned
          // independently of this kernel. Neither is OAS_HOME_DIR, which is
          // the package STORE root — do not conflate them.
          OAS_EVENT: event, OAS_INSTANCE: instance, OAS_INSTANCE_HOME: home, OAS_HOME: home, OAS_AGENT: agentName,
          OAS_CAPABILITY: cap.id, OAS_LAYER: cap.layer || "", OAS_ROOT: rootDir || "",
          OAS_SOUL: soulDir || "", OAS_CONTEXT: contextDir, OAS_WORKSPACE: workspaceDir || "", OAS_LEVEL: cap.level || "",
          OAS_TEAM_NAME: resolved.team?.name || "", OAS_TEAM_ID: resolved.team?.id || "", OAS_TEAM_SCOPE: resolved.team?.scope || "",
          ...extraEnv,
          OAS_SETTINGS: JSON.stringify(cap.settings || {}),
          OAS_META: JSON.stringify(priorMeta[cap.id] || {}),
        },
      }).trim();
      const lastLine = stdout.split("\n").filter(Boolean).pop() || "{}";
      let o = {};
      try { o = JSON.parse(lastLine); } catch { /* non-JSON hook output is fine */ }
      if (o.meta) results.meta[cap.id] = o.meta;
      if (o.brief) results.briefs.push(`- ${o.brief}`);
      if (o.warning) results.warnings.push(o.warning);
      if (o.launch && typeof o.launch === "object") for (const [rt, args] of Object.entries(o.launch)) results.launch[rt] = `${results.launch[rt] ? `${results.launch[rt]} ` : ""}${args}`;
    } catch (e) {
      // A failing hook may already have created EXTERNAL state (aweb joins a
      // team before it can report success). Its stdout is the only channel for
      // handing that back, so parse it exactly as the success path does —
      // discarding it strands whatever the hook created, because compensation
      // would call retire with no metadata to act on (reviewer-bb40fa8).
      let reported;
      try {
        const failed = String(e.stdout ?? "").trim().split("\n").filter(Boolean).pop() || "{}";
        const o = JSON.parse(failed);
        if (o && typeof o === "object") {
          if (o.meta) results.meta[cap.id] = o.meta;
          // The hook's OWN diagnosis — "run `oas aweb setup`", "set team.id" —
          // is the actionable part. Without it the caller sees only
          // "Command failed: node …", which tells an operator nothing about
          // what to do (reviewer-5b78764).
          if (typeof o.warning === "string" && o.warning.trim()) reported = o.warning.trim();
        }
      } catch { /* non-JSON output from a failed hook is fine */ }
      const detail = reported || String(e.message || e).slice(0, 200);
      results.warnings.push(`${cap.id} ${event} hook failed (continuing): ${detail}`);
      // Structured failure record — compensation/rollback callers must be able
      // to DETECT hook failures, not just print them (warnings are advisory).
      const required = (cap.requiredHooks || []).includes(event);
      results.failures.push({ capability: cap.id, event, message: detail, required });
    }
  }
  return results;
}

// ---------- agents ----------
/** All local-agent base dirs readable for a root: the scope sibling (canonical)
 * plus legacy nested locations. */
function localAgentBases(root) {
  return [localAgentsDirOf(root), ...LEGACY_LOCAL_DIRS.map((l) => join(root, l))];
}
/** Ensure the scope's local-agents/ dir exists; when the scope is a git repo,
 * inject "local-agents/" into its .gitignore if not already ignored. Local souls
 * are uncommitted BY CONTRACT — the kernel enforces the ignore, not the user. */
export function ensureLocalAgentsDir(root) {
  const dir = localAgentsDirOf(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const scope = dirname(dir);
  if (shTry(`git -C ${shq(scope)} rev-parse --show-toplevel`)) {
    // Already ignored (any rule, any level)? git check-ignore answers exactly that.
    if (!shInTry(scope, `git check-ignore -q ${shq(LOCAL_AGENTS_DIR)} && echo yes`)) {
      const gi = join(scope, ".gitignore");
      const text = existsSync(gi) ? readFileSync(gi, "utf8") : "";
      writeFileSync(gi, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n# OAS local souls — never committed\n${LOCAL_AGENTS_DIR}/\n`);
    }
  }
  return dir;
}
function agentDirOf(root, name, kind) {
  if (kind !== "local") return join(root, name);
  for (const base of localAgentBases(root)) {
    if (existsSync(join(base, name, "soul"))) return join(base, name); // keep existing souls where they live
  }
  return join(ensureLocalAgentsDir(root), name);
}
function soulOf(agentDir) { return join(agentDir, "soul"); }
function readSoul(agentDir) {
  const p = join(soulOf(agentDir), "soul.yaml");
  if (!existsSync(p)) return undefined;
  const soul = parseYamlFlat(readFileSync(p, "utf8"));
  soul._dir = agentDir;
  soul.name = soul.name || basename(agentDir);
  if (soul.kind === "tmp") soul.kind = "local"; // legacy kind, one shape now: full local souls
  return soul;
}
export function findAgent(root, name) {
  for (const dir of [join(root, name), ...localAgentBases(root).map((b) => join(b, name))]) {
    const soul = readSoul(dir);
    if (soul) return soul;
  }
  return undefined;
}

/** Canonical capability-defined agents: a manifest's `agents: ["agents/reviewer"]`
 * entries are package-relative soul directories (soul.yaml + AGENTS.md directly
 * inside). They resolve like local souls when the capability is ACTIVE in the
 * context; the soul stays read-only in the package (fresh identity every spawn —
 * no long-term memory), while instances home under the scope's local-agents/. */
/** Capability ids DECLARED anywhere in the chain (any target — global, type, or
 * soul). Capability agents resolve on declaration, not per-soul binding: the
 * reviewer must be spawnable from any context of a deployment that adopted it. */
function declaredCapabilityIds(contextDir) {
  const ids = new Set();
  try {
    for (const cfg of configChain(contextDir)) for (const { id } of configCapabilityEntries(cfg)) if (id) ids.add(id);
  } catch { /* unreadable config — no capability agents */ }
  return ids;
}
function capabilityAgentMetadata(manifest, rel) {
  const soulDir = manifestPath(manifest, rel);
  const soulFile = manifestPath(manifest, join(rel, "soul.yaml"));
  if (!soulDir || !soulFile) return undefined;
  // Read only contained identity metadata to decide whether this provider owns
  // the requested name. Full tree containment + trust happen after a match.
  const soul = parseYamlFlat(readFileSync(soulFile, "utf8"));
  return { soulDir, soul, name: soul.name || basename(soulDir) };
}
function capabilityAgentProviderTrust(manifest, contextDir) {
  const trust = manifestTrust(manifest, contextDir, false);
  if (!trust.trusted) throw oasError("integrity-drift", `capability agent provider "${manifest.capability}" is not trusted: ${trust.reason}`, [{ capability: manifest.capability, origin: manifest._origin, reason: trust.reason }]);
  return trust;
}
export function findCapabilityAgent(contextDir, root, name) {
  const matchedFailures = [];
  for (const id of declaredCapabilityIds(contextDir)) {
    const manifest = capabilityManifest(id, contextDir);
    for (const rel of manifest?.agents || []) {
      let meta;
      try { meta = capabilityAgentMetadata(manifest, rel); } catch { continue; }
      if (!meta || meta.name !== name) continue; // never trust/read unrelated provider trees
      try {
        capabilityAgentProviderTrust(manifest, contextDir);
        assertCapabilityTreeContained(manifest, meta.soulDir, "agent");
        return {
          ...meta.soul, name,
          kind: "capability", capability: id,
          _dir: join(localAgentsDirOf(root), name),
          _soulDir: meta.soulDir,
        };
      } catch (e) { matchedFailures.push(e); }
    }
  }
  if (matchedFailures.length) throw matchedFailures[0];
  return undefined;
}
/** All capability-defined agents declared in a context (for status/errors).
 * Invalid providers degrade independently; diagnostics is a non-enumerable
 * array property so existing roster consumers keep the public array shape. */
export function listCapabilityAgents(contextDir) {
  const out = [];
  const diagnostics = [];
  Object.defineProperty(out, "diagnostics", { value: diagnostics, enumerable: false });
  for (const id of declaredCapabilityIds(contextDir)) {
    const manifest = capabilityManifest(id, contextDir);
    let trust;
    try { trust = manifest?.agents?.length ? capabilityAgentProviderTrust(manifest, contextDir) : undefined; }
    catch (e) {
      diagnostics.push({ capability: id, origin: manifest?._origin, code: e.code || "integrity-drift", message: e.message, provenance: e.provenance });
      continue;
    }
    for (const rel of manifest?.agents || []) {
      try {
        const meta = capabilityAgentMetadata(manifest, rel);
        if (meta) {
          assertCapabilityTreeContained(manifest, meta.soulDir, "agent");
          out.push({ name: meta.name, capability: id, description: meta.soul.description, soulDir: meta.soulDir });
        }
      } catch (e) {
        diagnostics.push({ capability: id, origin: manifest?._origin, code: e.code || "path-escape", message: e.message, provenance: [{ capability: id, path: rel }] });
      }
    }
  }
  return out;
}
export function listAgents(root) {
  const agents = [];
  const scan = (base, kind) => {
    if (!existsSync(base)) return;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || (kind === "persistent" && RESERVED.has(e.name))) continue;
      const soul = readSoul(join(base, e.name));
      if (soul) { soul.kind = soul.kind || kind; agents.push(soul); }
    }
  };
  scan(root, "persistent");
  for (const base of localAgentBases(root)) scan(base, "local");
  return agents;
}

/** Single-file agent defs from .claude/agents/*.md and .agents/agents/*.md, walking up from cwd. Closest wins. */
export function listAgentDefs(cwd = process.cwd()) {
  const defs = new Map();
  let d = resolve(cwd);
  while (true) {
    for (const rel of [join(".claude", "agents"), join(".agents", "agents")]) {
      const dir = join(d, rel);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        const path = join(dir, f);
        const { meta } = parseFrontmatter(readFileSync(path, "utf8"));
        const name = slug(meta.name || basename(f, ".md"));
        if (!defs.has(name)) defs.set(name, { name, path, description: meta.description, source: rel });
      }
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return [...defs.values()];
}

export function defaultRepo(cwd = process.cwd()) {
  return shTry(`git -C ${shq(resolve(cwd))} rev-parse --show-toplevel`);
}
export function resolveRepo(root, repo) {
  if (!repo) return undefined;
  const abs = isAbsolute(repo) ? repo : join(workspaceOf(root), repo);
  if (!existsSync(abs)) throw new Error(`repo not found: ${abs}`);
  if (!shTry(`git -C ${shq(abs)} rev-parse --git-dir`)) throw new Error(`not a git repo: ${abs}`);
  return abs;
}

// ---------- OKF (Open Knowledge Format) helpers ----------
export function todayISO() { return new Date().toISOString().slice(0, 10); }

/**
 * Append a one-line entry to an OKF log.md (newest-first, date-grouped per spec §7).
 * Creates the file with `# <title>` if missing.
 */
export function appendLogEntry(file, entry, title = "Log") {
  const today = todayISO();
  const text = existsSync(file) ? readFileSync(file, "utf8") : `# ${title}\n`;
  const lines = text.split("\n");
  const todayIdx = lines.findIndex((l) => l.trim() === `## ${today}`);
  if (todayIdx !== -1) {
    lines.splice(todayIdx + 1, 0, `* ${entry}`);
  } else {
    let h = lines.findIndex((l) => l.startsWith("# "));
    if (h === -1) h = 0;
    lines.splice(h + 1, 0, "", `## ${today}`, `* ${entry}`);
  }
  writeFileSync(file, lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

// (soul knowledge scaffolding belongs to capabilities/oas-okf — soul-scaffold hook)

// ---------- soul scaffolding ----------
function fileSnapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name); const rel = relative(dir, p);
      if (rel === ".oas-scaffold-owners.json") continue;
      if (e.isSymbolicLink()) out.set(rel, { kind: "symlink", value: readlinkSync(p) });
      else if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(rel, { kind: "file", value: readFileSync(p) });
    }
  };
  walk(dir); return out;
}
function sameSnapshotEntry(a, b) {
  return a?.kind === b?.kind && (a.kind === "file" ? a.value.equals(b.value) : a.value === b.value);
}
function restoreSnapshot(dir, before, after) {
  for (const file of after.keys()) if (!before.has(file)) rmSync(join(dir, file), { recursive: true, force: true });
  for (const [file, entry] of before) {
    if (sameSnapshotEntry(entry, after.get(file))) continue;
    const path = join(dir, file); mkdirSync(dirname(path), { recursive: true }); rmSync(path, { recursive: true, force: true });
    if (entry.kind === "symlink") symlinkSync(entry.value, path); else writeFileSync(path, entry.value);
  }
}
function runSoulScaffoldHooks(args) {
  const ownersFile = join(args.soulDir, ".oas-scaffold-owners.json");
  let owners = {};
  if (existsSync(ownersFile)) try { owners = JSON.parse(readFileSync(ownersFile, "utf8")); } catch { owners = {}; }
  for (const cap of args.resolved.capabilities || []) {
    if (!cap.hooks?.["soul-scaffold"]) continue;
    const before = fileSnapshot(args.soulDir);
    runLifecycleHooks("soul-scaffold", { ...args, resolved: { capabilities: [cap] } });
    const after = fileSnapshot(args.soulDir);
    const conflicts = [];
    for (const [file, entry] of after) {
      if (before.has(file) && !sameSnapshotEntry(before.get(file), entry) && owners[file] !== cap.id) conflicts.push(file);
      if (!before.has(file) && owners[file] && owners[file] !== cap.id) conflicts.push(file);
    }
    for (const file of before.keys()) if (!after.has(file) && owners[file] !== cap.id) conflicts.push(file);
    if (conflicts.length) {
      restoreSnapshot(args.soulDir, before, after);
      throw new Error(`soul-scaffold ownership conflict: ${cap.id} attempted ${[...new Set(conflicts)].join(", ")}`);
    }
    for (const file of after.keys()) if (!before.has(file)) owners[file] = cap.id;
  }
  if (Object.keys(owners).length) writeFileSync(ownersFile, JSON.stringify(owners, null, 2) + "\n");
}

export function writeSoul(root, { name, kind, repo, work, runtime, model, description, type, instructions }) {
  const agentDir = agentDirOf(root, name, kind);
  const soulDir = soulOf(agentDir);
  mkdirSync(soulDir, { recursive: true });
  mkdirSync(join(agentDir, "instances"), { recursive: true });
  writeFileSync(join(soulDir, "soul.yaml"), yamlFlat({
    name, kind, description, type, repo, work: work || "checkout", runtime: runtime || "pi", model,
  }));
  const agentsMd = join(soulDir, "AGENTS.md");
  if (instructions !== undefined || !existsSync(agentsMd)) {
    writeFileSync(agentsMd, instructions ?? defaultSoulAgentsMd(name, description));
  }
  // The committed soul remains canonical and config-independent. Composition happens in instances.
  const claudeMd = join(soulDir, "CLAUDE.md");
  try { lstatSync(claudeMd); } catch { symlinkSync("AGENTS.md", claudeMd); }
  const ctx = repo ? resolveRepo(root, repo) : (defaultRepo(root) || workspaceOf(root));
  const resolved = resolveOasConfig(ctx, name);
  runSoulScaffoldHooks({
    home: soulDir, instance: name, agentName: name, soulDir,
    contextDir: ctx, workspaceDir: workspaceOf(root), rootDir: root, resolved,
  });
  return { agentDir, soulDir };
}
function defaultSoulAgentsMd(name, description) {
  return `# ${name}

${description || "Describe this agent's role, boundaries, and conventions here."}

## Operating notes

- Your instance home contains \`./work\` — do all repository work inside it.
- Read \`./work/AGENTS.md\` / \`./work/CLAUDE.md\` (if present) before starting.
`;
}

export function createAgent(root, o) {
  const name = slug(o.name);
  if (RESERVED.has(name)) throw new Error(`"${name}" is a reserved name`);
  if (findAgent(root, name)) throw new Error(`agent "${name}" already exists`);
  if (o.repo) resolveRepo(root, o.repo);
  // kind: "local" → a FULL soul (memory, skills, instances) under the scope's
  // local-agents/ — uncommitted by contract; otherwise a committed persistent soul.
  const kind = o.local || o.kind === "local" ? "local" : "persistent";
  const { agentDir } = writeSoul(root, { ...o, name, kind });
  return { agent: name, kind, soul: soulOf(agentDir) };
}

/** Upsert a local agent soul (from raw instructions or a Claude-style def file).
 * Local souls are full souls — same scaffold and memory as persistent ones —
 * that live in the scope's uncommitted local-agents/. */
export function upsertLocalAgent(root, o) {
  let { name, instructions, description, model, repo, work, runtime } = o;
  if (o.file) {
    const f = resolve(o.file);
    if (!existsSync(f)) throw new Error(`file not found: ${f}`);
    const { meta, body } = parseFrontmatter(readFileSync(f, "utf8"));
    name = name || meta.name || basename(f, ".md");
    description = description ?? meta.description;
    model = model ?? meta.model;
    repo = repo ?? meta.repo;
    work = work ?? meta.work;
    runtime = runtime ?? meta.runtime;
    instructions = body;
  }
  if (!name) throw new Error("local agent requires a name");
  name = slug(name);
  if (RESERVED.has(name)) throw new Error(`"${name}" is a reserved name`);
  const existing = findAgent(root, name);
  if (existing && existing.kind !== "local") throw new Error(`"${name}" is a persistent agent — spawn it instead`);
  if (!existing && instructions === undefined) throw new Error(`local agent "${name}" needs instructions (none on disk yet)`);
  writeSoul(root, {
    name, kind: "local",
    repo: repo ?? existing?.repo, work: work ?? existing?.work,
    runtime: runtime ?? existing?.runtime, model: model ?? existing?.model,
    description: description ?? existing?.description, instructions,
  });
  return findAgent(root, name);
}
/** Back-compat alias: older installed capabilities (oas-okf ≤1.3.x) call this. */
export const upsertTmpAgent = upsertLocalAgent;

/**
 * All agents roots within a team scope: the scope's own agents/ plus each
 * direct child directory's agents/ (member repos). Deterministic shallow scan
 * — the team scope is the deployment boundary declared by `team:` in config.
 */
export function teamAgentRoots(teamScope) {
  const roots = [];
  // A scope counts when it has agents/ OR only local-agents/ (the canonical
  // agents root is then its — possibly absent — sibling agents/ dir).
  const push = (p) => {
    if ((existsSync(p) && lstatSync(p).isDirectory()) ||
        (existsSync(localAgentsDirOf(p)) && lstatSync(localAgentsDirOf(p)).isDirectory())) roots.push(resolve(p));
  };
  push(join(teamScope, "agents"));
  for (const e of readdirSync(teamScope, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "agents" || e.name === LOCAL_AGENTS_DIR || e.name === "node_modules") continue;
    push(join(teamScope, e.name, "agents"));
  }
  return roots;
}

/**
 * Cross-repo soul lookup within the declared team scope. Returns
 * { team, matches: [{ root, agent }] } when a `team:` block resolves from ctx,
 * undefined otherwise. The caller decides what to do with 0/1/many matches —
 * unique match wins, ambiguity is an error at the CLI.
 */
export function findTeamAgent(ctx, name) {
  const r = resolveOasConfig(ctx);
  if (!r.team) return undefined;
  const matches = [];
  for (const root of teamAgentRoots(r.team.scope)) {
    const agent = findAgent(root, name);
    if (agent) matches.push({ root, agent });
  }
  return { team: r.team, matches };
}

/**
 * Find an instance home by name across the team scope's agents roots.
 * Returns { root, agent, home } or undefined.
 */
export function findTeamInstance(ctx, instanceName) {
  const r = resolveOasConfig(ctx);
  if (!r.team) return undefined;
  for (const root of teamAgentRoots(r.team.scope)) {
    // findInstanceHome is defined below (hoisted): sees persistent, tmp, AND
    // capability-defined instance homes.
    const hit = findInstanceHome(root, instanceName);
    if (hit) return { root, agent: hit.agent, home: hit.home };
  }
  return undefined;
}

// ---------- instances ----------
function nextInstanceName(agent, purpose) {
  const base = purpose ? `${agent.name}-${slug(purpose)}` : undefined;
  const instancesDir = join(agent._dir, "instances");
  const existing = existsSync(instancesDir) ? readdirSync(instancesDir) : [];
  if (base) {
    let n = base, i = 2;
    while (existing.includes(n)) n = `${base}-${i++}`;
    return n;
  }
  let i = existing.length + 1, n;
  do { n = `${agent.name}-${i++}`; } while (existing.includes(n));
  return n;
}

function tmuxAlive(session) { return !!shTry(`tmux has-session -t ${shq(session)} 2>/dev/null && echo yes`); }
export function tmuxWindows(session = DEFAULT_TMUX_SESSION) {
  if (!tmuxAlive(session)) return [];
  return (shTry(`tmux list-windows -t ${shq(session)} -F '#{window_name}'`) || "").split("\n").filter(Boolean);
}

/**
 * Spawn an instance of `agent` (as returned by findAgent/listAgents).
 * o: { instance?, purpose?, repo?, work?, runtime?, model?, task?, taskFile?, branch?, launch?, tmuxSession? }
 */
/** The claude binary for a context: closest `oas-claude-config` (a one-line file
 * naming the binary, e.g. "claude-personal") walking up from contextDir wins; no
 * file → "claude". Local-only by design — a personal machine preference (account
 * selection), never committed config; keep it out of version control. */
export function resolveClaudeBinary(contextDir) {
  let d = resolve(contextDir);
  while (true) {
    const f = join(d, "oas-claude-config");
    if (existsSync(f)) {
      const name = readFileSync(f, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      if (name) return name;
    }
    const parent = dirname(d);
    if (parent === d) return "claude";
    d = parent;
  }
}

/** Resolve a model preference LIST (comma-separated "provider/id[:thinking]" patterns)
 * to the first entry whose provider/model is actually available to the runtime.
 * pi: checked against `pi --list-models <pattern>` (authenticated providers).
 * claude: pi-style patterns are translated (anthropic/<id> → <id>) or dropped —
 * claude takes aliases/bare claude-* ids only; nothing usable → "" (claude default).
 * Unknown runtimes or probe failures: first entry wins (pi errors loudly at launch). */
export function resolveModelPreference(model, runtime = "pi") {
  const prefs = String(model || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (runtime === "claude") {
    // Claude accepts its aliases and bare claude-* ids — NOT pi-style
    // "provider/model[:thinking]" patterns. Agents whose soul default is a
    // pi model are routinely runtime-overridden to claude; passing the pi
    // pattern through makes claude reject the model at launch (operator
    // report, dev-coordinator-claude-sessions). Translate anthropic-provider
    // entries to the bare id (strip provider + :thinking) and drop other
    // providers' entries; no usable entry ⇒ "" (claude's own default).
    for (const pref of prefs) {
      const bare = pref.replace(/:[a-z]+$/i, "");
      if (!bare.includes("/")) return bare;              // alias or bare claude-* id
      const [provider, ...rest] = bare.split("/");
      if (provider === "anthropic" && rest.length) return rest.join("/");
    }
    return "";
  }
  if (prefs.length <= 1) return prefs[0] || "";
  if (runtime !== "pi") return prefs[0];
  for (const pref of prefs) {
    const bare = pref.replace(/:[a-z]+$/i, ""); // strip :<thinking> for the catalog probe
    const [provider, ...rest] = bare.split("/");
    const id = rest.join("/");
    if (!id) return pref; // bare pattern (no provider) — let pi resolve it
    const out = shTry(`pi --list-models ${shq(id)} 2>/dev/null`) || "";
    const found = out.split("\n").some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[0] === provider && cols[1] === id;
    });
    if (found) return pref;
  }
  return prefs[0];
}

// Relations a new instance can declare to an existing one at spawn time.
// "unrelated" is the no-link default (normalized away before recording).
export const RELATIONS = ["child", "sibling", "parent", "unrelated"];


/** Verify the runtime packages that ACTIVE capabilities require for `runtime`.
 *
 * Each comes from a declared runtime-package requirement, so the capability has
 * stated the dependency and the user has consented to install it (`oas install`).
 * We verify PRESENCE and record provenance; we deliberately do NOT resolve the
 * extension's entry file. pi owns that resolution — its manifest supports globs
 * and exclusions, packages without a `pi` manifest use conventional directories,
 * and the package root is relocatable — so reimplementing it here would be a
 * second, wrong copy of pi's rules (reviewer-ad1b9f0). Extensions load through
 * pi's own discovery.
 *
 * Absence still fails the spawn: "aweb on pi requires the aweb pi package" is a
 * promise the instance's INSTRUCTIONS rely on, so starting without it would
 * leave the agent believing it can be woken by mail when it cannot. */
function verifyRuntimePackages(runtime, resolved, contextDir) {
  const found = [];
  const problems = [];
  // The session launches with the CONTEXT-SELECTED executable (oas-claude-config
  // may name `claude-personal`), so probing the literal `claude` would inspect a
  // different account's plugins than the instance will actually use.
  const probeOpts = runtime === "claude" ? { bin: resolveClaudeBinary(contextDir), context: contextDir } : { context: contextDir };
  for (const cap of resolved.capabilities || []) {
    for (const raw of cap.manifest?.requires || []) {
      if (!raw || typeof raw !== "object" || raw.runtime !== runtime) continue;
      const spec = raw.package;
      if (!safeRuntimePackageSpec(spec, runtime)) { problems.push(`${cap.id}: ${runtime} package spec is not a plain source token (${JSON.stringify(spec)})`); continue; }
      if (raw.marketplace !== undefined && !safeRuntimeSourceRef(raw.marketplace)) { problems.push(`${cap.id}: marketplace is not a plain source reference (${JSON.stringify(raw.marketplace)})`); continue; }
      const status = runtimePackageStatus(runtime, spec, process.env, probeOpts);
      const mgr = RUNTIME_PACKAGE_MANAGERS[runtime];
      const stepList = mgr?.steps ? mgr.steps(spec, raw, probeOpts) : [mgr?.argv(spec, raw, probeOpts) || []];
      const direct = stepList.filter((a) => a.length).map((a) => a.join(" ")).join(" && ");
      const remedy = `run \`oas install --accept-requirement ${runtime}:${runtimePackageIdentity(runtime, spec)} --dir ${contextDir}\`${direct ? ` (or \`${direct}\` directly)` : ""}`;
      if (!status.installed) { problems.push(`${cap.id} requires the ${runtime} package ${spec}, which is not installed — ${remedy}`); continue; }
      // A settings row is not proof the extension loads. Both of these leave the
      // capability silently absent, which is the loss this gate exists to stop.
      if (status.unverified) { problems.push(`${cap.id} requires the ${runtime} package ${spec}: it is configured, but OAS could not verify it is installed (${status.unverified}) — a config entry is not an installation; ${remedy}`); continue; }
      if (status.missingFiles) {
        problems.push(status.dir
          ? `${cap.id} requires the ${runtime} package ${spec}: ${runtime} lists it at ${status.dir}, but nothing is installed there — ${remedy}`
          : `${cap.id} requires the ${runtime} package ${spec}: ${runtime} has it configured but reports no installed location, so it was never installed — ${remedy}`);
        continue;
      }
      if (status.disabled) { problems.push(`${cap.id} requires the ${runtime} package ${spec}, which is installed but DISABLED, so it will not load — enable it (\`${probeOpts.bin || runtime} plugin enable ${spec}\` for Claude), or drop the capability for this soul`); continue; }
      if (status.extensionsDisabled) { problems.push(`${cap.id} requires the ${runtime} package ${spec}, but your ${runtime} settings entry sets "extensions": [], which loads none of them — remove that filter, or drop the capability for this soul`); continue; }
      if (status.extensionsFilter?.length) {
        // Unverifiable, not merely auditable: proving the filter selects this
        // capability's extension means implementing pi's glob semantics, and
        // guessing here is how an instance ends up promising a channel it does
        // not have. A filter on other resource kinds (skills) is unaffected.
        problems.push(`${cap.id} requires the ${runtime} package ${spec}, but your ${runtime} settings entry filters its extensions (${status.extensionsFilter.map((e) => JSON.stringify(e)).join(", ")}). OAS cannot verify that filter selects the required extension without reimplementing ${runtime}'s matcher — remove the "extensions" filter for this package (a skills-only filter is fine), or drop the capability for this soul`);
        continue;
      }
      found.push({ capability: cap.id, runtime, package: spec, identity: runtimePackageIdentity(runtime, spec), dir: status.dir, filtered: status.filtered });
    }
  }
  if (problems.length) {
    throw oasError("E_RUNTIME_RESOURCE_MISSING", `this instance runs on ${runtime}, and its active capabilities require runtime packages that are not installed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  const seen = new Set();
  return found.filter((x) => (seen.has(x.identity) ? false : seen.add(x.identity))).sort((a, b) => a.identity.localeCompare(b.identity));
}

export function spawnInstance(root, agent, o = {}) {
  const work = o.work || agent.work || "checkout";
  if (!WORK_MODES.includes(work)) throw new Error(`unknown work mode "${work}" (${WORK_MODES.join("|")})`);
  if (work === "attached" && !o.workDir) throw new Error(`attached mode needs workDir — the owning instance's work tree (its <home>/work)`);
  if (o.task !== undefined && typeof o.task !== "string") throw new Error(`task must be a string (got ${typeof o.task}) — a flag parser handing --task's next flag through shows up here`);
  const runtime = o.runtime || agent.runtime || "pi";
  const model = resolveModelPreference(o.model || agent.model || "", runtime);
  const session = o.tmuxSession || DEFAULT_TMUX_SESSION;
  const launch = o.launch !== false;
  const repoAbs = resolveRepo(root, o.repo || agent.repo);
  if (!repoAbs) throw new Error(`agent "${agent.name}" has no repo configured — pass one`);
  // Instance homes belong in the soul-owning repo's PRIMARY checkout, never in a
  // linked worktree (see canonicalDeploymentPath). The CLI resolves this through
  // ensureRoot, but the kernel is its own validation boundary — the desktop
  // server, the pi adapter and tests call spawnInstance directly — and the check
  // must run in the RAW caller shape, before mkdir or any lifecycle hook.
  //
  // BOTH paths are checked, because the home is `agent._dir/instances/<name>`,
  // NOT `root/...`: a caller can pass a canonical root together with an agent
  // resolved from the linked root (findAgent(linkedRoot, name)) and the home
  // would still land in the worktree with a root-only check (reviewer-2366d09).
  // Local and capability-defined souls home under the scope's sibling
  // local-agents/, so agent._dir is the authority in every layout.
  for (const [label, path] of [["agents root", root], [`agent directory for "${agent.name}"`, agent._dir]]) {
    if (!path) continue;
    const canonical = canonicalDeploymentPath(path);
    if (resolve(canonical) !== resolve(path)) {
      throw oasError("E_NO_CANONICAL_ROOT", `${label} ${resolve(path)} is inside a linked Git worktree — instance homes must be created in the primary checkout (${canonical}), where they survive the worktree and are visible to the deployment`);
    }
  }

  let instance = o.instance || nextInstanceName(agent, o.purpose);
  if (!instance.startsWith(agent.name)) instance = `${agent.name}-${slug(instance)}`;
  instance = slug(instance);

  // Forward-only lineage: EXPLICIT only. Relations (child|sibling|parent|unrelated)
  // anchor the new instance to an EXISTING instance (o.relativeTo). o.parent
  // (CLI --parent) is sugar for relation=child. Parsed and resolved BEFORE any
  // scaffolding or lifecycle hooks so an invalid relation or missing anchor
  // never leaves a half-created home behind. ATTACHED mode is special by design
  // decision: an attached agent shares its owner's work tree and is ALWAYS the
  // owner's child — relation flags that say anything else are contradictory and
  // rejected. Ambient env
  // (OAS_INSTANCE/PI_AGENT_INSTANCE) is deliberately NOT consulted: any shell
  // opened inside an agent's tmux window inherits those vars, and env inheritance
  // is not evidence of intent — human spawns from such shells were misattributed
  // as instance-origin. Manual spawns land top-level unless a relation is
  // explicitly given (operator directive).
  const legacyParent = typeof o.parent === "string" && o.parent.trim() ? o.parent.trim() : undefined;
  let relation = typeof o.relation === "string" && o.relation.trim() ? o.relation.trim() : undefined;
  let relativeTo = typeof o.relativeTo === "string" && o.relativeTo.trim() ? o.relativeTo.trim() : undefined;
  // Validate the RAW combination BEFORE normalization — the kernel is its own
  // validation boundary (programmatic callers bypass the CLI's checks), and
  // silently normalizing contradictory options into a different spawn shape
  // (e.g. dropping a dangling relativeTo → top-level) hides caller bugs.
  if (relation && !RELATIONS.includes(relation)) throw new Error(`unknown relation "${relation}" (child|sibling|parent|unrelated)`);
  if (legacyParent && (relation || relativeTo)) throw new Error(`parent is sugar for relativeTo + relation "child" — pass one form, not both`);
  if (relativeTo && !relation) throw new Error(`relativeTo "${relativeTo}" needs a relation (child|sibling|parent)`);
  if (relation === "unrelated" && relativeTo) throw new Error(`relation "unrelated" takes no relativeTo`);
  if (relation && relation !== "unrelated" && !relativeTo) throw new Error(`relation "${relation}" needs a relative-to instance`);
  if (typeof o.relativeRoot === "string" && o.relativeRoot.trim() && !relativeTo && !legacyParent) throw new Error(`relativeRoot only qualifies relativeTo/parent`);
  if (!relation && legacyParent) { relation = "child"; relativeTo = legacyParent; }
  if (relation === "unrelated") { relation = undefined; relativeTo = undefined; }

  // Attached = child of the work-tree owner, always (design decision). The
  // owner is CANONICALLY resolved BY PATH: every instance home in the
  // deployment (local root + team scope) is enumerated and matched on
  // realpath(<home>/work) === realpath(workDir) — never by name, since
  // instance names are only unique per agent dir and a same-named local
  // instance must not shadow the tree's true owner. For trees that are no
  // instance's home/work (e.g. a coordinator's integration worktree), the
  // spawner must name the owner explicitly with a child relation — nothing
  // else can attach there.
  let attachedOwner;
  if (work === "attached" && o.workDir) {
    const wd = resolve(o.workDir);
    let wdReal; try { wdReal = realpathSync(wd); } catch { wdReal = undefined; }
    let ownerName;
    if (wdReal) {
      const scanInstances = (agentsRoot, cb) => {
        for (const a of listAgents(agentsRoot)) {
          const dir = join(a._dir, "instances");
          if (!existsSync(dir)) continue;
          for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) cb(join(dir, e.name), e.name);
        }
        for (const lb of localAgentBases(agentsRoot)) {
          if (!existsSync(lb)) continue;
          for (const ag of readdirSync(lb, { withFileTypes: true })) {
            if (!ag.isDirectory()) continue;
            const dir = join(lb, ag.name, "instances");
            if (!existsSync(dir)) continue;
            for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) cb(join(dir, e.name), e.name);
          }
        }
      };
      const ownerRoots = new Set();
      try { ownerRoots.add(realpathSync(root)); } catch { ownerRoots.add(root); }
      try {
        const cfg2 = resolveOasConfig(repoAbs);
        // teamAgentRoots may return a nonexistent <scope>/agents when the scope
        // has only sibling local-agents/ — keep it (resolve, not drop) so
        // scanInstances still reaches localAgentBases(root).
        if (cfg2.team) for (const r2 of teamAgentRoots(cfg2.team.scope)) { try { ownerRoots.add(realpathSync(r2)); } catch { ownerRoots.add(resolve(r2)); } }
      } catch { /* local root only */ }
      const hits = [];
      // Lexical form of workDir with the HOME part canonicalized — checkout-mode
      // instances have work as a symlink to the shared repo, so realpath alone
      // would collide across every checkout instance; symlinked work trees only
      // match when workDir IS that home's work path.
      let wdLexical; try { wdLexical = join(realpathSync(dirname(wd)), basename(wd)); } catch { wdLexical = wd; }
      for (const r2 of ownerRoots) scanInstances(r2, (instHome, instName) => {
        const wp = join(instHome, "work");
        try {
          let homeReal; try { homeReal = realpathSync(instHome); } catch { return; }
          if (join(homeReal, "work") === wdLexical) { hits.push({ home: instHome, name: instName }); return; }
          if (!lstatSync(wp).isSymbolicLink() && realpathSync(wp) === wdReal) hits.push({ home: instHome, name: instName });
        } catch { /* no work tree */ }
      });
      if (hits.length) {
        ownerName = hits[0].name;
        // The owner must be representable unambiguously from the CHILD's root:
        // the recorded name, resolved like every other lineage edge (local
        // root first, then team), must land back on the matched home.
        const check = findInstanceHome(root, ownerName) || findTeamInstance(root, ownerName);
        let resolvesBack = false;
        try { resolvesBack = !!check && realpathSync(check.home) === realpathSync(hits[0].home); } catch { /* not resolvable */ }
        if (!resolvesBack) throw new Error(`attached workDir ${wd} belongs to instance "${ownerName}" (${hits[0].home}), but that name resolves to a different instance from this deployment root — the parent link would be ambiguous; retire/rename the shadowing instance or attach to a tree owned here`);
      }
    }
    if (ownerName) {
      attachedOwner = ownerName;
      if (relation && !(relation === "child" && relativeTo === attachedOwner)) {
        throw new Error(`attached agents are always children of the work-tree owner (${attachedOwner}) — drop the relation flags or use --work worktree for a different relation`);
      }
    } else {
      // Path matches NO known instance's work tree: require an explicit,
      // validated child link so the "attached = child" invariant still holds.
      if (!relation) throw new Error(`attached workDir ${wd} is not a known instance's <home>/work — name the owning instance explicitly (--parent <instance>)`);
      if (relation !== "child") throw new Error(`attached agents are always children — only --parent <instance> (child) is valid for a non-instance work tree`);
      attachedOwner = relativeTo;
    }
    if (o.relation === "unrelated") throw new Error(`attached agents are always children of the work-tree owner — "unrelated" contradicts attached mode`);
  }

  // Resolve the anchor's home so sibling and parent relations can read/re-point
  // the anchor's recorded lineage. Bare names are only unique per agent dir, so
  // resolution must be AMBIGUITY-SAFE (same posture as attached ownership):
  //  - enumerate ALL matches across the deployment (local root + team scope);
  //  - multiple matches need o.relativeRoot (CLI --relative-root) to pick one;
  //  - the recorded edge must ROUND-TRIP: the anchor's bare name, resolved from
  //    the NEW instance's root (local-first, like every lineage consumer),
  //    must land on the chosen home — else a same-named shadow would corrupt
  //    lineage. For relation=parent the reverse edge (anchor → new instance,
  //    by the new instance's bare name from the ANCHOR's root) must round-trip
  //    too, since the anchor's instance.json is re-pointed.
  let anchorHome;
  let anchorRoot;
  if (relativeTo) {
    const hits = [];
    for (const h of findInstanceHomes(root, relativeTo)) hits.push({ root, home: h.home });
    try {
      const cfgA = resolveOasConfig(repoAbs);
      if (cfgA.team) for (const r2 of teamAgentRoots(cfgA.team.scope)) {
        if (resolve(r2) === resolve(root)) continue;
        for (const h of findInstanceHomes(r2, relativeTo)) hits.push({ root: r2, home: h.home });
      }
    } catch { /* no team scope — local only */ }
    if (relation && !hits.length) throw new Error(`relation "${relation}": instance "${relativeTo}" was not found in this deployment`);
    let chosen = hits[0];
    if (hits.length > 1) {
      const wanted = typeof o.relativeRoot === "string" && o.relativeRoot.trim() ? resolve(o.relativeRoot.trim()) : undefined;
      const inRoot = wanted ? hits.filter((h) => resolve(h.root) === wanted) : [];
      // Two agents under ONE root can own the same name (generated-name
      // collisions); --relative-root cannot split those — inherently ambiguous.
      if (inRoot.length > 1) throw Object.assign(
        new Error(`relative-to "${relativeTo}" matches multiple instances under ${o.relativeRoot} (${inRoot.map((h) => h.home).join(", ")}) — inherently ambiguous; retire/rename one`),
        { code: "E_RELATIVE_AMBIGUOUS" });
      chosen = inRoot[0];
      if (!chosen) throw Object.assign(
        new Error(`relative-to "${relativeTo}" is ambiguous — it matches multiple instances (${hits.map((h) => h.home).join(", ")}); pass --relative-root <agents-root> to pick one`),
        { code: "E_RELATIVE_AMBIGUOUS" });
    } else if (chosen && typeof o.relativeRoot === "string" && o.relativeRoot.trim() && resolve(o.relativeRoot.trim()) !== resolve(chosen.root)) {
      throw Object.assign(new Error(`relative-to "${relativeTo}" does not home under --relative-root ${o.relativeRoot} (found at ${chosen.home})`), { code: "E_RELATIVE_AMBIGUOUS" });
    }
    if (chosen) {
      // Round-trip: the bare name recorded on the edge must resolve back to the
      // chosen home from the NEW instance's root, or the edge is a lie.
      const back = findInstanceHome(root, relativeTo) || findTeamInstance(root, relativeTo);
      let ok = false;
      try { ok = !!back && realpathSync(back.home) === realpathSync(chosen.home); } catch { ok = false; }
      if (!ok) throw Object.assign(
        new Error(`relative-to "${relativeTo}" at ${chosen.home} is shadowed by a same-named instance closer to this deployment root — the lineage edge would resolve to the wrong instance; retire/rename the shadowing instance`),
        { code: "E_RELATIVE_AMBIGUOUS" });
      anchorHome = chosen.home;
      anchorRoot = chosen.root;
      // relation=parent re-points the ANCHOR at the NEW instance by bare name:
      // that reverse edge must round-trip from the ANCHOR's root as well.
      if (relation === "parent") {
        const rev = findInstanceHome(chosen.root, instance) || findTeamInstance(chosen.root, instance);
        // The new instance does not exist yet — a hit here IS a shadow.
        if (rev) throw Object.assign(
          new Error(`relation "parent": an existing instance named "${instance}" (${rev.home}) would shadow the new instance from the anchor's root — the re-pointed edge would resolve to the wrong instance; pick a different --purpose`),
          { code: "E_RELATIVE_AMBIGUOUS" });
      }
    }
  }
  const anchorMetaPath = anchorHome ? join(anchorHome, "instance.json") : undefined;
  const anchorMeta = anchorMetaPath && existsSync(anchorMetaPath) ? JSON.parse(readFileSync(anchorMetaPath, "utf8")) : undefined;
  if ((relation === "sibling" || relation === "parent") && !anchorMeta) {
    throw new Error(`relation "${relation}" needs the anchor's recorded lineage, but instance "${relativeTo}" has no instance.json`);
  }

  let parentInstance;
  let siblingInstance;
  if (relation === "child") {
    parentInstance = relativeTo;
  } else if (relation === "sibling") {
    // Peer at the same level: share the anchor's parent. When the anchor is a
    // root (no parent), record an explicit sibling link so the two still form
    // one cluster (derivable from status --json via parentInstance+siblingInstance edges).
    if (anchorMeta?.parentInstance) parentInstance = anchorMeta.parentInstance;
    else siblingInstance = relativeTo;
  } else if (relation === "parent") {
    // The NEW instance becomes the anchor's parent: it inherits the anchor's old
    // slot in the tree (old parent, if any), and the anchor is re-pointed below.
    parentInstance = anchorMeta?.parentInstance;
    if (anchorMeta?.siblingInstance) siblingInstance = anchorMeta.siblingInstance;
  }
  if (!relation && attachedOwner && attachedOwner !== instance) parentInstance = attachedOwner;

  // Inherited edges must round-trip too. Sibling and parent relations copy
  // names from the ANCHOR's instance.json (anchorMeta.parentInstance /
  // .siblingInstance) — names the ANCHOR resolved from ITS root. The NEW
  // instance's root may resolve the same bare name to a different (same-named)
  // instance, silently mislinking. Before scaffolding: resolve each final
  // inherited name from the anchor's root AND from the new root; both must
  // canonicalize to the same home.
  if (relation === "sibling" || relation === "parent") {
    for (const inherited of [parentInstance, siblingInstance]) {
      if (!inherited || inherited === relativeTo || inherited === instance) continue;
      const fromAnchor = findInstanceHome(anchorRoot, inherited) || findTeamInstance(anchorRoot, inherited);
      const fromNew = findInstanceHome(root, inherited) || findTeamInstance(root, inherited);
      let same = false;
      try { same = !!fromAnchor && !!fromNew && realpathSync(fromAnchor.home) === realpathSync(fromNew.home); } catch { same = false; }
      // A vanished referent (no hit from the anchor root) is a dangling edge —
      // inheriting it is harmless only if the new root ALSO cannot resolve it.
      if (!fromAnchor && !fromNew) continue;
      if (!same) throw Object.assign(
        new Error(`relation "${relation}": inherited lineage "${inherited}" resolves to ${fromAnchor?.home || "nothing"} from the anchor's root but ${fromNew?.home || "nothing"} from this deployment root — the inherited edge would mislink; disambiguate or retire/rename the shadowing instance`),
        { code: "E_RELATIVE_AMBIGUOUS" });
    }
  }

  const home = join(agent._dir, "instances", instance);
  if (existsSync(home)) throw new Error(`instance already exists: ${home}`);
  // AUTHORITATIVE placement check, on the DESTINATION rather than on lexical
  // paths, immediately before the first side effect. The earlier root/agent-dir
  // checks are lexical and can be walked around by a symlink anywhere along the
  // way — `agents/alias -> <linked-worktree>/agents/dev`, or a pre-existing
  // `agent._dir/instances` symlink — which classifies as the primary checkout
  // while the home is really created in the worktree (reviewer-249aa7b).
  // Resolving through the nearest existing ancestor is what closes that.
  const homeReal = realPathOrNearest(home);
  const homeCanonical = canonicalDeploymentPath(homeReal);
  if (resolve(homeCanonical) !== resolve(homeReal)) {
    throw oasError("E_NO_CANONICAL_ROOT", `instance home ${home} resolves to ${homeReal}, inside a linked Git worktree — homes must be created in the primary checkout (${homeCanonical}); a symlink on the path to the agent directory or its instances/ dir does not change where the home really lands`);
  }
  // CONTAINMENT, which the check above does not give. canonicalDeploymentPath
  // only redirects paths inside a LINKED WORKTREE; an escape to a directory Git
  // does not own at all comes back unchanged and passed (reviewer-aggregate2 —
  // reproduced: a pre-existing `instances/` symlink to a sibling temp dir spawned
  // successfully, reporting a home under the deployment while the real one, with
  // the capability credentials a hook writes into it, was created outside).
  // The home must BE the immediate `instances/` child of the resolved agent
  // directory, and that directory must live in this deployment.
  const withinDir = (child, parent) => {
    const rel = relative(parent, child);
    return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
  };
  const agentDirReal = realPathOrNearest(agent._dir);
  // A base is only a base if it is WHERE IT CLAIMS TO BE. Resolving each one and
  // trusting the result made a symlinked base authoritative: `<scope>/local-agents
  // -> /foreign/repo` admitted /foreign/repo as a deployment base, so a local or
  // capability agent's home — and the credentials a hook writes into it — landed
  // there (reviewer-1a6e82e, reproduced). The agents root itself may legitimately
  // be a symlink (it is the deployment anchor, and OAS is pointed AT it); the
  // dirs OAS derives FROM it may not lead somewhere else.
  const rootReal = realPathOrNearest(root);
  const scopeReal = realPathOrNearest(dirname(root));
  const admitBase = (dir, parentReal) => {
    const real = realPathOrNearest(dir);
    return withinDir(real, parentReal) ? real : undefined;
  };
  const allowedBases = [
    rootReal,
    admitBase(localAgentsDirOf(root), scopeReal),                             // sibling: inside the scope
    ...LEGACY_LOCAL_DIRS.map((l) => admitBase(join(root, l), rootReal)),      // legacy: inside the root
  ].filter(Boolean);
  if (!allowedBases.some((b) => withinDir(agentDirReal, b))) {
    throw oasError("E_NO_CANONICAL_ROOT", `agent directory for "${agent.name}" resolves to ${agentDirReal}, which is outside this deployment (${allowedBases.join(", ")}) — a symlinked agent directory would place the home, and any capability credentials written into it, outside the deployment entirely`);
  }
  const expectedHome = join(agentDirReal, "instances", instance);
  if (resolve(homeReal) !== resolve(expectedHome)) {
    throw oasError("E_NO_CANONICAL_ROOT", `instance home ${home} resolves to ${homeReal}, not to ${expectedHome} — a symlinked instances/ directory does not change where the home really lands, and OAS will not create an instance (or the capability credentials that go in it) outside the agent's own directory`);
  }
  // Compose and PREFLIGHT before the home exists. Composition is pure (it only
  // reads the soul, config chain and capability content), so resolving it here
  // lets every "declared but missing" failure happen with zero side effects to
  // roll back — no home, no worktree, no identity, no tmux window.
  // Capability-defined agents carry _soulDir (read-only soul inside the package).
  const soulDir = agent._soulDir || soulOf(agent._dir);
  const composition = composeInstanceAgentsMd(soulDir, repoAbs, agent.name, work, agent.kind);
  const resolvedCfg = composition.resolved;
  const expectedResources = planInstanceResources({ resolved: resolvedCfg, soulDir, agent, contextDir: repoAbs, composition });
  // Runtime extensions selected by ACTIVE capabilities for THIS instance's
  // runtime. Strict launch disables ambient extension discovery, so each one has
  // to be named by path — and a required runtime package that is not installed
  // must fail here, loudly, rather than produce an instance that silently lost
  // its channel. `--runtime` can override a soul default long after install-time
  // reconciliation, so this spawn-time check is the authoritative one.
  const runtimePackages = verifyRuntimePackages(runtime, resolvedCfg, repoAbs);

  mkdirSync(home, { recursive: true });
  // TOCTOU: the placement checks above ran BEFORE composition and the runtime
  // package preflight, both of which shell out — a window in which anything able
  // to write in the agent directory can swap `instances/` for a link elsewhere,
  // and mkdirSync follows it (reviewer-a6aa1c5). Re-assert on the directory that
  // now exists, before a single file is written into it or any hook runs.
  // This narrows the window to the mkdir itself rather than closing it outright:
  // Node has no openat/O_NOFOLLOW-relative API, so a truly hostile filesystem
  // needs OS-level protection on the deployment, not a pathname check.
  const createdReal = realpathSync(home);
  if (resolve(createdReal) !== resolve(expectedHome)) {
    // Remove only what we just made, only if it is still empty, and never
    // recursively — whatever lives at an unexpected destination is not ours.
    try { rmdirSync(createdReal); } catch { /* not empty or not removable: leave it and say so */ }
    throw oasError("E_NO_CANONICAL_ROOT", `instance home ${home} was created at ${createdReal}, not at ${expectedHome} — the path changed after it was validated (a swapped instances/ link), so nothing has been written into it and the spawn is aborted`);
  }

  // Body: the soul is linked for reference, while instructions are a generated instance-local view.
  symlinkSync(soulDir, join(home, "soul"));
  writeFileSync(join(home, "AGENTS.md"), composition.text);
  symlinkSync("AGENTS.md", join(home, "CLAUDE.md"));

  // Runtime-neutral exact skill materialization. No harness receives ambient workspace/package skills.
  const sources = [{ id: "kernel", path: join(PACKAGED_SKILLS_DIR, "oas") }, { id: "kernel", path: join(PACKAGED_SKILLS_DIR, "oas-config") }, { id: "kernel", path: join(PACKAGED_SKILLS_DIR, "oas-packages") }];
  const soulSkills = join(soulDir, "skills");
  if (existsSync(soulSkills)) sources.push({ id: "soul", path: soulSkills });
  for (const cap of resolvedCfg.capabilities) for (const path of cap.skills || []) sources.push({ id: cap.id, path });
  // A capability-defined agent always carries its OWN capability's skills and
  // injection, regardless of config targeting (the reviewer needs its review
  // skills even though oas.review targets the developers type).
  if (agent.kind === "capability" && agent.capability && !resolvedCfg.capabilities.some((c) => c.id === agent.capability)) {
    for (const path of capabilitySkillDirs(agent.capability, repoAbs)) sources.push({ id: agent.capability, path });
  }
  const overrides = {};
  for (const cfg of resolvedCfg.chain) for (const [skill, source] of Object.entries(cfg["skill-overrides"] || {})) if (!(skill in overrides)) overrides[skill] = source;
  const chosen = new Map();
  const offer = (name, src, source) => {
    if (!chosen.has(name)) { chosen.set(name, { src, source }); return; }
    const prior = chosen.get(name);
    const winner = overrides[name];
    if (!winner) throw new Error(`duplicate skill "${name}" from ${prior.source} and ${source}; set skill-overrides.${name}`);
    if (winner === source) chosen.set(name, { src, source });
    else if (winner !== prior.source) throw new Error(`skill override for "${name}" names ${winner}, but candidates are ${prior.source}, ${source}`);
  };
  // Same enumerator preflight used, so "what a tree promises" and "what gets
  // copied" cannot drift apart.
  for (const source of sources) for (const entry of skillEntriesIn(source.path)) offer(entry.name, entry.src, source.id);
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  for (const [name, selected] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
    // Pi's recursive skill scanner does not descend through directory symlinks.
    // Copy each selected tree so the exact instance-local set is real and immutable.
    copyTreeSafe(realpathSync(selected.src), join(home, ".agents", "skills", name));
  }
  symlinkSync(join("..", ".agents", "skills"), join(home, ".claude", "skills"));

  // EXPECTED == MATERIALIZED. Preflight proved every declared resource resolves;
  // this proves the copies actually landed, so "the composition is complete" is
  // an asserted fact rather than an inference from no error having been thrown.
  // `.agents/skills` is canonical and `.claude/skills` aliases it, so the alias
  // is verified to resolve exactly onto the canonical tree and nowhere else.
  const materialized = [...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, source: v.source, from: v.src }));
  const incomplete = [];
  for (const m of materialized) {
    if (!hasSkillDoc(join(home, ".agents", "skills", m.name))) incomplete.push(`skill "${m.name}" (from ${m.source}) did not materialize as a readable SKILL.md`);
  }
  // Reconcile against what was PROMISED, not only against what was selected:
  // iterating `materialized` alone can never notice a promised skill that never
  // entered the set (reviewer-400c1e6). Matching is by NAME because an explicit
  // skill-override may legitimately satisfy a promised name from another source.
  for (const r of expectedResources) {
    for (const name of r.entries || []) {
      if (!chosen.has(name)) incomplete.push(`skill "${name}", promised by ${r.source} (${r.declared}), is missing from the composed set`);
    }
  }
  for (const r of expectedResources) {
    if (r.type === "injection" && !composition.blocks.some((b) => b.file === r.path)) incomplete.push(`injection from ${r.source} (${r.declared}) resolved but is not present in the composed AGENTS.md`);
  }
  const aliasTarget = realPathOrNearest(join(home, ".claude", "skills"));
  if (aliasTarget !== realPathOrNearest(join(home, ".agents", "skills"))) {
    incomplete.push(`.claude/skills resolves to ${aliasTarget}, not the canonical .agents/skills tree`);
  }
  if (incomplete.length) {
    // Nothing outside the home exists yet (no worktree, no hooks, no window), so
    // removing the scaffold is the whole rollback.
    let removal = "";
    try { rmSync(home, { recursive: true, force: true }); } catch (e) { removal = ` — rollback INCOMPLETE, remove ${home} manually: ${e.message}`; }
    throw oasError("E_COMPOSITION_INCOMPLETE", `the instance composition did not materialize completely:\n${incomplete.map((m) => `  ${m}`).join("\n")}${removal}`);
  }

  // Work tree.
  let branch;
  let worktreeCanonical; // captured immediately after add, before setup/hooks can mutate/remove it
  if (work === "worktree") {
    branch = o.branch || `agents/${instance}`;
    const wt = join(home, "work");
    let added = false;
    try {
      execFileSync("git", ["-C", repoAbs, "worktree", "add", wt, "-b", branch],
        { stdio: ["ignore", "pipe", "pipe"] });
      added = true;
      // Git registers a canonical path. Retain it now: compensation hooks can
      // remove/make the directory inaccessible before rollback verification.
      worktreeCanonical = realpathSync(wt);
    } catch (e) {
      const original = e.stderr?.toString().trim() || e.message;
      const incomplete = [];
      if (added) {
        // Canonicalization failed AFTER add: cleanup is a transaction too.
        // Capture every failure and verify Git effects; because canonical
        // identity was unavailable, never claim confirmed worktree absence.
        const run = (argv) => {
          try { return { ok: true, out: execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
          // With encoding:"utf8" a silent command yields stderr === "" — FALSY — so
          // `e2.stderr || e2.message` fell through to "Command failed: …" and made
          // every clean probe look like a failed one. `git rev-parse --verify
          // --quiet` on an absent ref is exactly that case, so a successful branch
          // deletion could never be confirmed and rollback always reported
          // INCOMPLETE. Distinguish "no output" from "no stderr captured".
          catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr ?? e2.message ?? "").trim() }; }
        };
        const remove = run(["git", "-C", repoAbs, "worktree", "remove", "--force", wt]);
        if (!remove.ok) incomplete.push(`git worktree ${wt}: remove failed (${remove.err || `exit ${remove.status}`})`);
        const prune = run(["git", "-C", repoAbs, "worktree", "prune"]);
        if (!prune.ok) incomplete.push(`git worktree ${wt}: prune failed (${prune.err || `exit ${prune.status}`})`);
        const list = run(["git", "-C", repoAbs, "worktree", "list", "--porcelain", "-z"]);
        if (!list.ok) incomplete.push(`git worktree ${wt}: could not verify removal (${list.err || "worktree list failed"})`);
        else incomplete.push(`git worktree ${wt}: could not verify removal (canonical path unavailable after add)`);
        const del = run(["git", "-C", repoAbs, "branch", "-D", branch]);
        if (!del.ok) incomplete.push(`git branch ${branch}: deletion failed (${del.err || `exit ${del.status}`})`);
        const ref = run(["git", "-C", repoAbs, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (ref.ok) incomplete.push(`git branch ${branch}: still exists`);
        else if (ref.status !== 1 || ref.err) incomplete.push(`git branch ${branch}: could not verify deletion (${ref.err || `exit ${ref.status}`})`);
      }
      try { rmSync(home, { recursive: true, force: true }); } catch (e2) { incomplete.push(`instance home ${home}: ${e2.message}`); }
      const note = incomplete.length ? ` — rollback INCOMPLETE — clean up manually: ${incomplete.join("; ")}` : "";
      throw new Error(`git worktree add/canonicalization failed: ${original}${note}`);
    }
  } else if (work === "attached") {
    // Attach to ANOTHER instance's work tree (o.workDir): sibling home, shared tree.
    // The tree belongs to its owner — retire never removes it (work/ is a symlink).
    if (!o.workDir || !existsSync(o.workDir)) { rmSync(home, { recursive: true, force: true }); throw new Error(`attached mode needs workDir (got: ${o.workDir})`); }
    symlinkSync(resolve(o.workDir), join(home, "work"));
    branch = shTry(`git -C ${shq(o.workDir)} rev-parse --abbrev-ref HEAD`);
  } else if (work === "workspace") {
    // Cross-repo coordinator: ./work is the TEAM SCOPE (deployment boundary), not
    // a repo — member repos are read-context; repo edits are routed, not made.
    // Requires a declared boundary: config team: scope, else the workspace scope.
    const resolvedCfgEarly = composition.resolved;
    const wsRoot = resolvedCfgEarly.team?.scope
      || resolvedCfgEarly.chain?.find((c) => c._level !== homedir())?._level;
    if (!wsRoot) { rmSync(home, { recursive: true, force: true }); throw new Error(`workspace mode needs a declared boundary — add a "team:" block (or a workspace-scope oas-config.yaml) so ./work has a root`); }
    symlinkSync(resolve(wsRoot), join(home, "work"));
    branch = undefined; // no repo identity: the workspace is not a git tree
  } else {
    symlinkSync(repoAbs, join(home, "work"));
    branch = shTry(`git -C ${shq(repoAbs)} rev-parse --abbrev-ref HEAD`);
  }

  // Work-mode setup command (worktree env bootstrap). The work-mode briefing is
  // composed into the instance's AGENTS.md, not TASK.md.
  const wm = resolveWorkMode(repoAbs, work);
  const warnings = [];
  if (work === "worktree" && wm.setup) {
    try { shIn(join(home, "work"), wm.setup, 300000); }
    catch (e) { warnings.push(`worktree setup command failed (continuing): ${String(e.message || e).slice(0, 200)}`); }
  }

  // Capability lifecycle hooks (spawn) — the knowledge integration scaffolds instance
  // memory (STATE.md/log.md/notes/ are OKF conventions, not kernel ones); the
  // messaging integration mints the comms identity. Kernel stays memory-agnostic.
  const task = o.task ?? (o.taskFile ? readFileSync(o.taskFile, "utf8") : "");
  const hookRes = runLifecycleHooks("spawn", {
    home, instance, agentName: agent.name, soulDir, contextDir: repoAbs,
    workspaceDir: workspaceOf(root), resolved: resolvedCfg,
    extraEnv: { OAS_TASK: task, OAS_REPO: repoAbs, OAS_BRANCH: branch || "", OAS_WORK: work, OAS_RUNTIME: runtime, OAS_KIND: agent.kind || "persistent" },
  });
  warnings.push(...hookRes.warnings);
  // A REQUIRED spawn hook that failed means an active capability is not actually
  // configured — aweb without a minted identity is an agent that believes it can
  // be woken by mail and cannot. Fail the spawn and roll back, rather than hand
  // over a half-configured instance. Nothing is launched yet, so compensation is
  // retire hooks + worktree/branch + home; the same three-state verification as
  // the anchor-write path, because a cleanup we cannot confirm must never be
  // reported as done.
  const requiredFailures = (hookRes.failures || []).filter((f) => f.required);
  if (requiredFailures.length) {
    const incomplete = [];
    const probe = (argv) => {
      try { return { ok: true, out: execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
      // With encoding:"utf8" a silent command yields stderr === "" — FALSY — so
          // `e2.stderr || e2.message` fell through to "Command failed: …" and made
          // every clean probe look like a failed one. `git rev-parse --verify
          // --quiet` on an absent ref is exactly that case, so a successful branch
          // deletion could never be confirmed and rollback always reported
          // INCOMPLETE. Distinguish "no output" from "no stderr captured".
          catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr ?? e2.message ?? "").trim() }; }
    };
    // Which capabilities still owe cleanup, as IDS the retry can verify against —
    // the prose in `incomplete` tells a human what happened, but a retry needs
    // something it can check. Without this, a retry that resolves no capabilities
    // at all (a descriptor naming none, or config drift since the spawn) runs zero
    // hooks, finds zero failures, and clears the quarantine having done nothing
    // (reviewer-dd03a98).
    const outstandingHooks = new Set();
    const outstandingGit = new Set();
    try {
      const comp = runLifecycleHooks("retire", {
        home, instance, agentName: agent.name, soulDir, contextDir: repoAbs,
        workspaceDir: workspaceOf(root), rootDir: root, resolved: resolvedCfg,
        priorMeta: hookRes.meta || {},
      });
      for (const f of comp.failures || []) { incomplete.push(`retire hook ${f.capability}: ${f.message}`); outstandingHooks.add(f.capability); }
      // A compensation hook may exit 0 yet report that it did not finish. Only
      // an explicit "nothing to undo" counts as complete; anything else means
      // external state (a remote identity) may still exist, and the rollback
      // must not be announced as clean while the local key that could delete it
      // is about to be removed.
      for (const [capId, m] of Object.entries(comp.meta || {})) {
        if (m && typeof m === "object" && m.retired === false && m.reason !== "nothing-to-delete") {
          incomplete.push(`retire hook ${capId}: reported incomplete cleanup${m.reason ? ` (${m.reason})` : ""} — external state may remain`);
          outstandingHooks.add(capId);
        }
      }
    } catch (e2) {
      incomplete.push(`retire hooks: ${e2.message}`);
      // The whole pass died, so which hooks ran is unknown: every capability that
      // HAS a retire hook is outstanding until a retry proves otherwise.
      for (const cap of resolvedCfg.capabilities) if (cap.hooks?.retire) outstandingHooks.add(cap.id);
    }
    if (work === "worktree") {
      const wt = join(home, "work");
      probe(["git", "-C", repoAbs, "worktree", "remove", "--force", wt]);
      probe(["git", "-C", repoAbs, "worktree", "prune"]);
      const wtProbe = probe(["git", "-C", repoAbs, "worktree", "list", "--porcelain", "-z"]);
      if (!wtProbe.ok) { incomplete.push(`git worktree ${worktreeCanonical || wt}: could not verify removal (${wtProbe.err || "worktree list failed"})`); outstandingGit.add("worktree"); }
      else {
        const registered = wtProbe.out.split("\0").filter((f) => f.startsWith("worktree ")).map((f) => f.slice("worktree ".length));
        if (worktreeCanonical && registered.includes(worktreeCanonical)) { incomplete.push(`git worktree ${worktreeCanonical}: still registered`); outstandingGit.add("worktree"); }
      }
      if (branch) {
        probe(["git", "-C", repoAbs, "branch", "-D", branch]);
        const brProbe = probe(["git", "-C", repoAbs, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (brProbe.ok) { incomplete.push(`git branch ${branch}: still exists`); outstandingGit.add("branch"); }
        else if (brProbe.status !== 1 || brProbe.err) { incomplete.push(`git branch ${branch}: could not verify deletion (${brProbe.err || `rev-parse exit ${brProbe.status}`})`); outstandingGit.add("branch"); }
      }
    }
    // A quarantine that lists nothing outstanding would be a proof obligation of
    // zero — exactly the vacuous success this whole path exists to prevent
    // (reviewer-2baa631). `incomplete` is non-empty here by construction, so if
    // neither category caught it, fall back to the conservative rule: every
    // capability that HAS a retire hook still owes one.
    const outstandingRecord = () => {
      if (!outstandingHooks.size && !outstandingGit.size) {
        for (const cap of resolvedCfg.capabilities) if (cap.hooks?.retire) outstandingHooks.add(cap.id);
      }
      return { hooks: [...outstandingHooks], git: [...outstandingGit] };
    };
    // A capability whose REQUIRED spawn hook failed while declaring no retire hook
    // is the one case where compensation runs nothing and reports nothing: zero
    // failures, an empty `incomplete`, and the clean-rollback path below deletes
    // the home — with whatever credential that hook wrote in it — while whatever
    // it created remotely lives on (reviewer-446ebe1). OAS cannot undo it and
    // cannot know whether there is anything to undo, so it must not assume there
    // is not. Fail closed: quarantine and let the operator decide.
    for (const f of requiredFailures) {
      const cap = resolvedCfg.capabilities.find((c) => c.id === f.capability);
      if (cap?.hooks?.retire) continue;
      // Only when the failed hook REPORTED something. Metadata is how a hook says
      // "I created this, here is what you need to undo it" — the same channel
      // compensation reads — so a hook that reported nothing has recorded nothing
      // to undo, and the clean rollback stands. A hook that DID report, with no
      // retire hook behind it, has handed OAS a receipt for state it cannot act on.
      if (!hookRes.meta?.[f.capability]) continue;
      incomplete.push(`${f.capability}: its ${f.event} hook is declared required and reported state it created, but the capability declares no retire hook, so OAS cannot undo it`);
      outstandingHooks.add(f.capability);
    }
    const detail = requiredFailures.map((f) => `  ${f.capability} ${f.event} hook (declared required): ${f.message}`).join("\n");
    let note;
    if (incomplete.length) {
      // QUARANTINE, do not delete. Compensation could not finish, and the home
      // holds the very credentials and metadata a retry needs — for aweb,
      // <instance-home>/.aw is the only signing key that can self-delete the
      // remote identity. Removing it converts a transient cleanup failure into
      // permanent remote residue (aggregate review at 798b156). The worktree and
      // branch are already gone where that was independently safe; nothing is
      // launched.
      const marker = join(home, ".oas-rollback-incomplete.json");
      try {
        writeFileSync(marker, JSON.stringify({
          instance, agent: agent.name, reason: "required spawn hook failed and compensation did not complete",
          // Capability/hook names and cleanup diagnostics only — never hook output.
          failed: requiredFailures.map((f) => ({ capability: f.capability, event: f.event })),
          incomplete, retainedFor: "credentials/metadata needed to retry cleanup",
          // The CLEANUP DESCRIPTOR. instance.json is not written until after
          // hooks succeed, so a retry would otherwise find no metadata, skip
          // every retire hook and delete the home anyway — stranding exactly the
          // external state the quarantine exists to recover. These are the
          // fields retireInstance needs, in the shape it already reads.
          cleanup: {
            // Versioned: a kernel that does not understand this shape must treat
            // the marker as unusable rather than guess at a retry.
            version: QUARANTINE_CLEANUP_VERSION,
            repo: repoAbs, work, branch,
            outstanding: outstandingRecord(),
            capabilityRuntime: resolvedCfg.capabilities.map((cap) => ({
              id: cap.id, layer: cap.layer, level: cap.level, settings: cap.settings,
              hooks: cap.hooks, requiredHooks: cap.requiredHooks, missingRequires: cap.missingRequires,
              trust: cap.trust, executable: cap.executable,
            })),
            capabilityMeta: hookRes.meta || {},
          },
          createdAt: new Date().toISOString(),
        }, null, 2) + "\n");
      } catch { /* the quarantine still stands without its marker */ }
      note = ` — rollback INCOMPLETE. The instance home is RETAINED at ${home} because it holds the state needed to finish cleanup; it is not a live instance. Retry with \`oas retire ${instance}\`, then remove it once cleanup succeeds. Outstanding: ${incomplete.join("; ")}`;
    } else {
      try { rmSync(home, { recursive: true, force: true }); } catch (e2) { incomplete.push(`instance home ${home}: ${e2.message}`); }
      if (existsSync(home) && !incomplete.some((m) => m.startsWith("instance home"))) incomplete.push(`instance home ${home}: still present`);
      note = incomplete.length ? ` — rollback INCOMPLETE, clean up manually: ${incomplete.join("; ")}` : " — spawn rolled back";
    }
    throw oasError("E_REQUIRED_HOOK_FAILED", `a capability this soul activates could not configure itself:\n${detail}\n\nThe capability declares this hook required, so the instance would have started without it${note}`);
  }
  const briefLines = hookRes.briefs.length ? `\n${hookRes.briefs.join("\n")}` : "";
  const workDesc = work === "worktree"
    ? `a dedicated git worktree of ${repoAbs} on branch "${branch}" — commit freely there`
    : work === "attached"
    ? `ATTACHED to another instance's work tree (${o.workDir}, branch ${branch}) — you share it with that instance; make your changes and commits focused, and never switch branches`
    : work === "workspace"
    ? `the WHOLE WORKSPACE (${realpathSync(join(home, "work"))}) — every member repo is read-context; you coordinate, you do not edit member repos (see your work-mode briefing)`
    : `a symlink to the ${repoAbs} checkout — you share it; work on the currently checked-out branch (${branch}) and do not switch branches without being asked`;
  writeFileSync(join(home, "TASK.md"), `# Instance briefing: ${instance}

You are instance "${instance}" of agent "${agent.name}".
- Home: ${home}${resolvedCfg.team ? `\n- Team: ${resolvedCfg.team.name}${resolvedCfg.team.id ? ` (${resolvedCfg.team.id})` : ""} — see teammates with \`oas status --team\`` : ""}
- Work tree: ./work — ${workDesc}
- Do all repository work inside ./work. Read ./work/AGENTS.md or ./work/CLAUDE.md first if present.${briefLines}
${task.trim() ? `\n## Task\n\n${task.trim()}\n` : "\nNo task was provided at spawn time — await instructions.\n"}`);

  // Launch command. Spawn IS session start: this command is persisted in
  // instance.json and executed in the instance's tmux window. Capabilities may
  // contribute runtime-specific arguments via their spawn hook's `launch` map
  // (e.g. aweb's Claude Code channel plugin flags).
  const claudeBin = runtime === "claude" ? resolveClaudeBinary(repoAbs) : undefined;
  const bin = which(runtime === "claude" ? claudeBin : "pi");
  if (!bin) throw new Error(`${runtime === "claude" ? claudeBin : runtime} binary not found on PATH${claudeBin && claudeBin !== "claude" ? " (named by oas-claude-config)" : ""}`);
  const hookArgs = hookRes.launch?.[runtime] ? ` ${hookRes.launch[runtime]}` : "";
  let cmdline;
  if (runtime === "claude") {
    // .claude/skills already links the OAS-composed instance skill set.
    // "--" terminates option parsing BEFORE the prompt: capability launch
    // hooks can contribute greedy/variadic flags (e.g. aweb's
    // --dangerously-load-development-channels), and without the separator
    // the TASK.md text is swallowed as that flag's next value — claude
    // errors out ("entries must be tagged: <task text>") and the window
    // drops to the fallback shell, which reads as a silently stuck spawn.
    cmdline = `${shq(bin)}${model ? ` --model ${shq(model)}` : ""}${hookArgs} -- "$(cat TASK.md)"`;
  } else {
    // STRICT CURRICULUM (pi): the OAS-composed set — no user, ancestor, project
    // or package skill catalogs, and no auto-discovered AGENTS.md/CLAUDE.md.
    // NOT "nothing else can contribute": extensions stay ambient by founder
    // ruling (see below), and an extension's resources_discover hook can add
    // skill paths that survive --no-skills. The OAS-managed root is exact; the
    // extension surface is the operator's, and stating otherwise here would
    // contradict the paragraph twelve lines down (reviewer-aggregate2).
    //
    //   --no-skills          ends discovery; --skill stays additive.
    //   --no-context-files   stops ancestor AGENTS.md/CLAUDE.md auto-injection.
    //                        It also stops the instance's OWN composed AGENTS.md
    //                        loading, so that is delivered explicitly via
    //                        --append-system-prompt. The work tree's AGENTS.md
    //                        stays READABLE by the read tool: readable, not
    //                        auto-injected, is the contract.
    //   --no-prompt-templates  same posture for ambient prompt templates.
    //
    // Built-in tools and pi's native interaction model are untouched — OAS
    // curates the curriculum, it does not cripple the runtime.
    //
    // EXTENSIONS STAY AMBIENT, by founder ruling: operators run cross-agent pi
    // extensions (web search, output formatting) that every instance should
    // keep. So no --no-extensions, and no -e flags either — pi discovers the
    // installed extensions itself, and passing them explicitly as well would
    // load the same extension twice.
    //
    // The trade-off is deliberate and narrow: an extension's
    // `resources_discover` hook can contribute skill paths that survive
    // --no-skills. Today only the OAS bridge does that, and inside an instance
    // it contributes that instance's OWN .agents/skills, so the composed set is
    // unchanged. A third-party extension that contributes skills WOULD add them,
    // which is the accepted residue of keeping shared extensions working.
    // Capability-required runtime packages are still verified and recorded
    // (verifyRuntimePackages), so "aweb on pi requires the aweb pi package"
    // still holds — it is loaded by pi's own discovery rather than by flag.
    cmdline = `${shq(bin)} --no-skills --skill ${shq(join(home, ".agents", "skills"))}`
      + ` --no-context-files --no-prompt-templates`
      + ` --append-system-prompt ${shq(join(home, "AGENTS.md"))}`
      + ` --approve --name ${shq(instance)}${model ? ` --model ${shq(model)}` : ""}${hookArgs} ${shq("@TASK.md")}`;
  }
  // OAS_INSTANCE_HOME is the runtime-neutral contract name (absolute path to
  // the instance home) exported to EVERY runtime. PI_AGENT_HOME/PI_AGENT_INSTANCE
  // are pi-branded predecessors kept as compatibility aliases: the separately
  // published @oas-framework/pi extension and bin/oas.mjs still read them, and
  // an older installed extension must keep working against a newer kernel.
  cmdline = `OAS_INSTANCE=${shq(instance)} OAS_INSTANCE_HOME=${shq(home)} PI_AGENT_INSTANCE=${shq(instance)} PI_AGENT_HOME=${shq(home)} ${cmdline}`;

  const meta = {
    agent: agent.name, kind: agent.kind || "persistent", instance, home,
    repo: repoAbs, work, branch, runtime, model: model || undefined,
    team: resolvedCfg.team || undefined,
    parentInstance: parentInstance && parentInstance !== instance ? parentInstance : undefined,
    siblingInstance: siblingInstance && siblingInstance !== instance ? siblingInstance : undefined,
    relation: relation || undefined,
    relativeTo: relation ? relativeTo : undefined,
    spawnOrigin: relation || (parentInstance && parentInstance !== instance) ? "instance" : "operator",
    capabilityMeta: Object.keys(hookRes.meta).length ? hookRes.meta : undefined,
    layers: Object.keys(resolvedCfg.provenance).length ? resolvedCfg.provenance : undefined,
    capabilities: resolvedCfg.capabilities.map((cap) => ({
      id: cap.id, layer: cap.layer, command: cap.command, origin: cap.origin, level: cap.level,
      settings: cap.settings, provenance: cap.provenance, skills: cap.skills || [],
      hooks: Object.keys(cap.hooks || {}), trusted: !!cap.trust?.trusted,
    })),
    skills: [...chosen].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => ({ name, source: v.source })),
    instructions: composition.blocks.map((b) => ({ source: b.source, file: b.file })),
    // The auditable record of the curriculum: what the resolved composition
    // PROMISED, and what actually landed. Both are asserted equal before launch;
    // keeping both makes an instance's surface reviewable after the fact without
    // re-resolving config that may since have changed.
    composition: {
      expected: expectedResources.map((r) => ({ type: r.type, source: r.source, declared: r.declared, resolved: r.path, origin: r.origin, level: r.level })),
      materialized: {
        skills: materialized.map((m) => ({ name: m.name, source: m.source, from: m.from })),
        instructions: composition.blocks.map((b) => ({ source: b.source, file: b.file })),
        // `filtered` records that the operator's settings entry narrows this
        // package's resources. A non-empty filter is a deliberate choice whose
        // glob semantics belong to the runtime, so it is auditable here rather
        // than second-guessed at spawn.
        runtimePackages: runtimePackages.map((x) => ({ capability: x.capability, runtime: x.runtime, package: x.package, dir: x.dir, filtered: x.filtered, loadedBy: "runtime-discovery" })),
        // What this instance ACTUALLY sees beyond the OAS-composed set. Recorded
        // so the deviation from strict composition is auditable instead of
        // implied — the honest contract, not an aspiration.
        runtimePosture: runtime === "claude"
          ? {
            oasComposed: "skills via .claude/skills -> ../.agents/skills; instructions via CLAUDE.md -> AGENTS.md",
            ambient: ["user skills", "project and ancestor skills to the repository root", "user and project plugins", "user and project settings", "user and ancestor CLAUDE.md"],
            why: "founder ruling: Claude Code's own global and per-repo configuration stays enabled — it is powerful, and the operator decides. An all-OAS setup is the way to opt out.",
          }
          : {
            oasComposed: "skills via --skill <instance-home>/.agents/skills; instructions via --append-system-prompt",
            curtailed: ["user skills", "project and ancestor skills", "package skills", "ambient AGENTS.md/CLAUDE.md discovery", "ambient prompt templates"],
            ambient: ["globally configured pi extensions, and any resources they contribute"],
            why: "founder ruling: shared cross-agent pi extensions (web search, output formatting) stay available to every instance.",
          },
        canonicalSkillTree: join(home, ".agents", "skills"),
        skillAlias: { path: join(home, ".claude", "skills"), target: join("..", ".agents", "skills") },
      },
    },
    capabilityRuntime: resolvedCfg.capabilities.map((cap) => ({
      id: cap.id, layer: cap.layer, level: cap.level, settings: cap.settings,
      hooks: cap.hooks, missingRequires: cap.missingRequires, trust: cap.trust,
      executable: cap.executable,
    })),
    tmux: { session, window: instance },
    command: cmdline, createdAt: new Date().toISOString(),
  };
  writeFileSync(join(home, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
  const spawnWarnings = warnings;

  let launched = false;
  if (launch) {
    if (!which("tmux")) throw new Error("tmux not installed (brew install tmux)");
    if (!tmuxAlive(session)) {
      const hq = existsSync(root) ? root : workspaceOf(root); // all-local scopes may have no agents/ dir
      sh(`tmux new-session -d -s ${shq(session)} -n hq -c ${shq(hq)}`);
      shTry(`tmux set-option -t ${shq(session)} -g window-size latest`);
      shTry(`tmux set-option -t ${shq(session)} -g aggressive-resize on`);
    }
    if (tmuxWindows(session).includes(instance)) throw new Error(`tmux window "${instance}" already exists in session ${session}`);
    // Wrap the command so the window drops into an interactive shell when the
    // agent exits (e.g. Ctrl-C) instead of tmux killing the window.
    const windowCmd = `${cmdline}; exec "\${SHELL:-/bin/zsh}"`;
    sh(`tmux new-window -t ${shq(session)} -n ${shq(instance)} -c ${shq(home)} ${shq(windowCmd)}`);
    launched = true;
  }

  // parent relation: re-point the ANCHOR's recorded lineage so its parent is
  // the new instance (e.g. a maintainer reviewing the spawner sits above it).
  // Committed LAST — after every other fallible step incl. launch — so a
  // failed spawn (missing tmux, window collision, new-window error) never
  // leaves the anchor's graph pointing at a zombie. --no-launch reaches here
  // too: the scaffold itself succeeded, which is that path's definition of
  // success. The write ITSELF is fallible (anchor retired concurrently,
  // unwritable file): on failure the spawn is COMPENSATED — kill the launched
  // window and remove the scaffold — so the operation stays all-or-nothing:
  // either agent live + lineage recorded, or neither.
  if (relation === "parent" && anchorMeta && anchorMetaPath) {
    // Atomic anchor update: writeFileSync truncates-then-writes, so a mid-write
    // failure (ENOSPC, I/O) could leave the anchor's instance.json empty.
    // Write a same-directory temp file and rename it over the anchor — rename
    // is atomic on POSIX, so the anchor is always either old or new, never
    // truncated.
    const tmpPath = `${anchorMetaPath}.tmp-${instance}`;
    try {
      anchorMeta.parentInstance = instance;
      delete anchorMeta.siblingInstance; // the new parent carries the old sibling link
      writeFileSync(tmpPath, JSON.stringify(anchorMeta, null, 2) + "\n");
      renameSync(tmpPath, anchorMetaPath);
    } catch (e) {
      // Compensation steps are each independent and best-effort: no step may
      // abort the remaining rollback or mask the original anchor-write error
      // (rmSync force:true only suppresses ENOENT — EPERM/IO still throw).
      // Failures are COLLECTED and reported: the thrown message must never
      // claim a cleanup that did not happen.
      const incomplete = [];
      // Verification probes are argv-based (no shell interpolation — branch
      // names may contain valid-but-hostile metacharacters like $(…)) and
      // THREE-STATE: confirmed-absent | still-present | could-not-verify.
      // Both of the latter are reported — a failed probe must never pass as
      // a confirmed cleanup (fail closed).
      const probe = (argv) => {
        try { return { ok: true, out: execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
        // With encoding:"utf8" a silent command yields stderr === "" — FALSY — so
          // `e2.stderr || e2.message` fell through to "Command failed: …" and made
          // every clean probe look like a failed one. `git rev-parse --verify
          // --quiet` on an absent ref is exactly that case, so a successful branch
          // deletion could never be confirmed and rollback always reported
          // INCOMPLETE. Distinguish "no output" from "no stderr captured".
          catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr ?? e2.message ?? "").trim() }; }
      };
      let windowUnresolved = false;
      try { rmSync(tmpPath, { force: true }); } catch (e2) { incomplete.push(`temp file ${tmpPath}: ${e2.message}`); }
      if (launched) {
        // shTry returns "" on success and undefined on failure — neither is a
        // reliable signal for kill-window, so verify the EFFECT unconditionally.
        shTry(`tmux kill-window -t ${shq(`=${session}:=${instance}`)}`);
        const winProbe = probe(["tmux", "list-windows", "-t", session, "-F", "#{window_name}"]);
        if (!winProbe.ok) { incomplete.push(`tmux window ${session}:${instance}: could not verify removal (${winProbe.err || "list-windows failed"})`); windowUnresolved = true; }
        else if (winProbe.out.split("\n").includes(instance)) { incomplete.push(`tmux window ${session}:${instance} still running`); windowUnresolved = true; }
      }
      // Outstanding debt as IDS, so a retry can verify it — same contract the
      // required-hook rollback records.
      const outstandingHooks = new Set();
      const outstandingGit = new Set();
      let compMeta = hookRes.meta || {};
      try {
        const comp = runLifecycleHooks("retire", {
          home, instance, agentName: agent.name, soulDir, contextDir: repoAbs,
          workspaceDir: workspaceOf(root), rootDir: root, resolved: resolvedCfg,
          priorMeta: hookRes.meta || {},
        });
        // runLifecycleHooks catches hook errors internally — detect them via
        // the structured failures field, not this outer catch.
        for (const f of comp.failures || []) { incomplete.push(`retire hook ${f.capability}: ${f.message}`); outstandingHooks.add(f.capability); }
        // Exit 0 while reporting "not retired" is also unfinished cleanup.
        for (const [capId, m] of Object.entries(comp.meta || {})) {
          if (m && typeof m === "object" && m.retired === false && m.reason !== "nothing-to-delete") {
            incomplete.push(`retire hook ${capId}: reported incomplete cleanup${m.reason ? ` (${m.reason})` : ""} — external state may remain`);
            outstandingHooks.add(capId);
          }
        }
        compMeta = { ...compMeta, ...(comp.meta || {}) };
      } catch (e2) {
        incomplete.push(`retire hooks: ${e2.message}`);
        for (const cap of resolvedCfg.capabilities) if (cap.hooks?.retire) outstandingHooks.add(cap.id);
      }
      if (work === "worktree") {
        const wt = join(home, "work");
        // Git canonicalizes symlinked parent components when registering a
        // worktree. Use the path captured immediately after successful add —
        // retire-hook compensation may already have removed/inaccessible'd wt.
        const wtCanonical = worktreeCanonical;
        if (!wtCanonical) incomplete.push(`git worktree ${wt}: could not verify removal (canonical path unavailable)`);
        probe(["git", "-C", repoAbs, "worktree", "remove", "--force", wt]);
        probe(["git", "-C", repoAbs, "worktree", "prune"]);
        // Verify effects, not exit codes: parse exact NUL-delimited `worktree`
        // records (never substring-match a lexical path against Git's canonical
        // registered path). The tree must be deregistered or later rmSync(home)
        // strands stale Git metadata.
        const wtProbe = probe(["git", "-C", repoAbs, "worktree", "list", "--porcelain", "-z"]);
        if (!wtProbe.ok) { incomplete.push(`git worktree ${wtCanonical}: could not verify removal (${wtProbe.err || "worktree list failed"})`); outstandingGit.add("worktree"); }
        else {
          const registered = wtProbe.out.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice("worktree ".length));
          if (wtCanonical && registered.includes(wtCanonical)) { incomplete.push(`git worktree ${wtCanonical}: still registered`); outstandingGit.add("worktree"); }
        }
        if (branch) {
          probe(["git", "-C", repoAbs, "branch", "-D", branch]);
          // rev-parse --verify: exit 0 = ref exists; exit 1 with empty stderr
          // under --quiet = confirmed absent; anything else = could not verify.
          const brProbe = probe(["git", "-C", repoAbs, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
          if (brProbe.ok) { incomplete.push(`git branch ${branch}: still exists`); outstandingGit.add("branch"); }
          else if (brProbe.status !== 1 || brProbe.err) { incomplete.push(`git branch ${branch}: could not verify deletion (${brProbe.err || `rev-parse exit ${brProbe.status}`})`); outstandingGit.add("branch"); }
        }
      }
      // QUARANTINE, do not delete. This path deleted the home unconditionally —
      // including while its own retire hook was reporting failure — which is
      // exactly the credential destruction the required-hook path was fixed to
      // avoid (reviewer-terminal54a87fd). A quarantine with nothing outstanding
      // would be a proof obligation of zero, so the record is filled
      // conservatively when both categories somehow came up empty.
      // Quarantine only for state that COMPENSATION owns and did not finish: a
      // retire hook that failed, Git the rollback could not undo, or a window
      // still running. Litter beside the anchor (a leftover temp file) is
      // reported but is not the child's external state, and retaining a home
      // for it would turn an ordinary failure into a --force cleanup.
      const unresolved = outstandingHooks.size > 0 || outstandingGit.size > 0 || windowUnresolved;
      let rollbackNote;
      if (unresolved) {
        if (!outstandingHooks.size && !outstandingGit.size) {
          for (const cap of resolvedCfg.capabilities) if (cap.hooks?.retire) outstandingHooks.add(cap.id);
        }
        rollbackNote = quarantineInstanceHome({
          home, instance, agent, incomplete,
          failed: [{ capability: "oas.kernel", event: "spawn" }],
          outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg,
          // The SPAWN metadata — the aweb alias a retry needs to delete the
          // remote identity. Passing the compensation result overwrote it with
          // `{retired:false}`, discarding the very handle cleanup requires.
          hookMeta: hookRes.meta || {}, compensationMeta: compMeta,
        }).replace(/^ — /, "");
      } else {
        try { rmSync(home, { recursive: true, force: true }); } catch (e2) { incomplete.push(`instance home ${home}: ${e2.message}`); }
        if (existsSync(home) && !incomplete.some((m) => m.startsWith("instance home"))) incomplete.push(`instance home ${home}: still present`);
        rollbackNote = incomplete.length
          ? `rollback INCOMPLETE — clean up manually: ${incomplete.join("; ")}`
          : "spawn rolled back (window killed, hooks compensated, scaffold removed)";
      }
      throw new Error(`relation "parent": failed to re-point anchor "${relativeTo}" (${e.message}) — ${rollbackNote}`);
    }
  }

  return { ...meta, launched, attach: `tmux attach -t ${session}`, warnings: spawnWarnings.length ? spawnWarnings : undefined };
}

export function listInstances(root, tmuxSession = DEFAULT_TMUX_SESSION) {
  const windows = tmuxWindows(tmuxSession);
  const readInstancesOf = (agentDir) => {
    const instancesDir = join(agentDir, "instances");
    return (existsSync(instancesDir) ? readdirSync(instancesDir, { withFileTypes: true }) : [])
      .filter((e) => e.isDirectory())
      .map((e) => {
        const metaPath = join(instancesDir, e.name, "instance.json");
        const home = join(instancesDir, e.name);
        const meta = existsSync(metaPath)
          ? JSON.parse(readFileSync(metaPath, "utf8"))
          : { instance: e.name, home };
        // A home retained by an incomplete rollback is NOT a live instance: it
        // is preserved state awaiting cleanup, and must read that way.
        const quarantine = join(home, ".oas-rollback-incomplete.json");
        let rollbackIncomplete;
        if (existsSync(quarantine)) {
          try { rollbackIncomplete = JSON.parse(readFileSync(quarantine, "utf8")); }
          catch { rollbackIncomplete = { reason: "rollback incomplete" }; }
        }
        return { ...meta, running: windows.includes(meta.instance || e.name), ...(rollbackIncomplete ? { rollbackIncomplete } : {}) };
      });
  };
  const out = listAgents(root).map((a) => {
    const { _dir, ...soul } = a;
    return { ...soul, dir: _dir, instances: readInstancesOf(a._dir) };
  });
  // Capability-defined agents home under local-agents/<name>/ WITHOUT a local
  // soul (it lives read-only in the package) — surface their instances too.
  const seen = new Set(out.map((a) => a.name));
  for (const dir of localAgentBases(root)) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const instances = readInstancesOf(join(dir, e.name));
      if (!instances.length) continue;
      const cap = instances.find((i) => i.capability)?.capability;
      out.push({ name: e.name, kind: "capability", capability: cap, description: cap ? `capability agent (${cap})` : "capability agent", dir: join(dir, e.name), instances });
      seen.add(e.name);
    }
  }
  return out;
}

// Locate an instance home under an agents root, including capability-defined
// agents homing under local-agents/<name>/ WITHOUT a local soul (listAgents
// cannot see those). Shared by retireInstance and `oas spawn --parent`.
// SECURITY: `name` is caller-controlled (CLI args, API bodies). It must be a
// plain instance name — reject path separators/dots up front, and verify the
// hit resolves to an IMMEDIATE child of an instances/ dir (realpath
// containment), or `oas retire ../../dev/soul` would existence-match and
// recursively delete a canonical soul.
const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export function findInstanceHome(root, name) {
  const all = findInstanceHomes(root, name);
  return all.length ? all[0] : undefined;
}

/** ALL homes matching an instance name under one agents root — names are only
 * unique per agent dir, so distinct agents (incl. generated-name collisions
 * like `dev --purpose foo-1` vs agent `dev-foo`) can own the same name.
 * Ambiguity-sensitive callers must use this, not first-match. Same
 * containment/charset guarantees as findInstanceHome. */
export function findInstanceHomes(root, name) {
  if (typeof name !== "string" || !INSTANCE_NAME_RE.test(name)) return [];
  const contained = (agentDir) => {
    const home = join(agentDir, "instances", name);
    if (!existsSync(home)) return undefined;
    try {
      const real = realpathSync(home);
      if (dirname(real) !== realpathSync(join(agentDir, "instances")) || basename(real) !== name) return undefined;
    } catch { return undefined; }
    return home;
  };
  const out = [];
  const seen = new Set();
  const push = (agent, home) => {
    // listAgents(root) already includes local souls from localAgentBases; the
    // fallback scan below re-visits those dirs for soul-less capability homes —
    // dedupe by canonical home so all-matches callers never see double hits.
    let key; try { key = realpathSync(home); } catch { key = resolve(home); }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ agent, home });
  };
  for (const a of listAgents(root)) {
    const home = contained(a._dir);
    if (home) push(a, home);
  }
  for (const dir of localAgentBases(root)) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const home = contained(join(dir, e.name));
      if (home) push({ name: e.name, kind: "capability", _dir: join(dir, e.name) }, home);
    }
  }
  return out;
}

/** The quarantine cleanup-descriptor contract version. Bump when the shape the
 * retry consumes changes, so an older/newer marker fails closed instead of
 * driving a retry that cannot do what it claims.
 *
 * The rule applies from the first RELEASE of this shape onward. Markers are only
 * ever written when a `required` spawn hook fails, and required hooks do not
 * exist in any released kernel — so no deployment can hold a marker of an earlier
 * v1 shape, and there is nothing to migrate from. A migration path for a file
 * that has never existed would be dead code claiming to protect real data. */
export const QUARANTINE_CLEANUP_VERSION = 1;
/** The rollback-owned Git steps a quarantine can still owe. */
export const QUARANTINE_GIT_DEBT = ["worktree", "branch"];

/** Retain a half-built instance home and mark it, so `oas retire <instance>` can
 * finish the cleanup that failed. THE one implementation: a spawn has two
 * rollback paths — a failed required hook, and a failure after the instance was
 * already launched (re-pointing a parent anchor) — and the second one deleted the
 * home while its own retire hook was reporting failure, destroying the credential
 * needed to undo the external state that survived (reviewer-terminal54a87fd).
 * Two copies of this logic is how that divergence happened; there is now one. */
function quarantineInstanceHome({ home, instance, agent, incomplete, failed, outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg, hookMeta, compensationMeta }) {
  try {
    writeFileSync(join(home, ".oas-rollback-incomplete.json"), JSON.stringify({
      instance, agent: agent.name, reason: "spawn rolled back and compensation did not complete",
      // Capability/hook names and cleanup diagnostics only — never hook output.
      failed, incomplete, retainedFor: "credentials/metadata needed to retry cleanup",
      // What the failed compensation reported, kept OUT of the cleanup
      // descriptor so it can never displace the spawn metadata a retry needs.
      ...(compensationMeta && Object.keys(compensationMeta).length ? { compensationReported: compensationMeta } : {}),
      cleanup: {
        version: QUARANTINE_CLEANUP_VERSION,
        repo: repoAbs, work, branch,
        outstanding: { hooks: [...outstandingHooks], git: [...outstandingGit] },
        capabilityRuntime: (resolvedCfg.capabilities || []).map((cap) => ({
          id: cap.id, layer: cap.layer, level: cap.level, settings: cap.settings,
          hooks: cap.hooks, requiredHooks: cap.requiredHooks, missingRequires: cap.missingRequires,
          trust: cap.trust, executable: cap.executable,
        })),
        capabilityMeta: hookMeta || {},
      },
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n");
  } catch { /* the quarantine still stands without its marker */ }
  return ` — rollback INCOMPLETE. The instance home is RETAINED at ${home} because it holds the state needed to finish cleanup; it is not a live instance. Retry with \`oas retire ${instance}\`, then remove it once cleanup succeeds. Outstanding: ${incomplete.join("; ")}`;
}

/** A cleanup descriptor is usable only if it can DRIVE the retry, so it is checked
 * as the strict contract its one producer writes — the rollback above — and to the
 * depth the retry CONSUMES it. Three rounds of review landed on this: validating
 * the outer shape only moved the failure from "unparseable" to "parseable and
 * useless", and every tolerance ("field optional", "array is enough") turned into
 * a retry that resolved nothing, reported no failures, and CLEARED the quarantine
 * — deleting the credential while the external state it was holding survived.
 *
 * Required, because the producer always writes them and the retry needs each one:
 * `version` (the contract), `repo` (resolves capabilities and reruns hooks),
 * `work` + `branch`-when-worktree (the rollback-owned Git steps; an unrecognised
 * mode silently skips them), `capabilityRuntime` (handed to runLifecycleHooks AS
 * the capability set, so it must BE one and must contain every outstanding hook),
 * and `outstanding.hooks` (what the retry has to prove it reran).
 *
 * Anything else reads as ABSENT — no more retryable than a missing marker — so the
 * home fails closed by default and `--force` can clear it. */
function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function nonEmptyString(v) { return typeof v === "string" && !!v.trim(); }
function usableCleanupDescriptor(marker) {
  const c = marker?.cleanup;
  if (!isPlainObject(c)) return false;
  if (c.version !== QUARANTINE_CLEANUP_VERSION) return false;
  if (!nonEmptyString(c.repo)) return false;
  if (!WORK_MODES.includes(c.work)) return false;
  if (c.work === "worktree" && !nonEmptyString(c.branch)) return false;
  if (c.branch !== undefined && !nonEmptyString(c.branch)) return false;
  if (c.capabilityMeta !== undefined && !isPlainObject(c.capabilityMeta)) return false;
  if (!Array.isArray(c.capabilityRuntime) || !c.capabilityRuntime.length) return false;
  if (!c.capabilityRuntime.every((cap) => isPlainObject(cap) && nonEmptyString(cap.id))) return false;
  if (!isPlainObject(c.outstanding) || !Array.isArray(c.outstanding.hooks) || !Array.isArray(c.outstanding.git)) return false;
  if (!c.outstanding.hooks.every(nonEmptyString)) return false;
  if (!c.outstanding.git.every((g) => QUARANTINE_GIT_DEBT.includes(g))) return false;
  // Git debt only exists where the rollback owns Git steps, so claiming it in any
  // other work mode describes a quarantine that could not have happened.
  if (c.outstanding.git.length && c.work !== "worktree") return false;
  // The decisive invariant: a quarantine with NOTHING outstanding is a proof
  // obligation of zero — the retry would run, prove nothing, and delete the home
  // and its credential (reviewer-2baa631). The producer cannot emit it, so a
  // marker claiming it is not one of ours.
  if (!c.outstanding.hooks.length && !c.outstanding.git.length) return false;
  // The retry must be ABLE to rerun what it must prove: an outstanding hook whose
  // capability is not in the set could never run, so the quarantine would never
  // clear — and the home would be unremovable without --force.
  const known = new Set(c.capabilityRuntime.map((cap) => cap.id));
  if (!c.outstanding.hooks.every((id) => known.has(id))) return false;
  return true;
}

export function retireInstance(root, name, o = {}) {
  const session = o.tmuxSession || DEFAULT_TMUX_SESSION;
  const self = o.self === true; // self-retire: the caller IS the instance — kill the window LAST
  const found = findInstanceHome(root, name);
  if (!found) throw new Error(`no instance named "${name}"`);
  const metaPath = join(found.home, "instance.json");
  // A QUARANTINED home (spawn failed after a required hook and compensation did
  // not finish) has no instance.json — it never got that far. Its marker carries
  // the cleanup descriptor in the same shape, so retire can rerun compensation
  // instead of silently skipping every hook and deleting the credentials.
  const quarantinePath = join(found.home, ".oas-rollback-incomplete.json");
  let quarantine;
  let markerUnusable = false;
  // A marker means the home is quarantined, WHETHER OR NOT instance.json exists:
  // the post-launch rollback retains a home that already has one, and gating on
  // its absence meant that quarantine was silently ignored — retire took the
  // ordinary path, where hook failures do not retain, and deleted the credential
  // while the external state survived (reviewer-final0130bc8).
  if (existsSync(quarantinePath)) {
    // A marker without a USABLE cleanup descriptor is NOT a quarantine we can
    // retry — it is an unidentified home. Treating an unusable one as retryable
    // made --force unable to ever clear it: the retry could not run, so the home
    // was retained again, forever (reviewer-adff009). "Parses as JSON" is not
    // the bar; "can actually drive the retry" is, so the shape is checked
    // against what the retry below consumes (reviewer-45ff039r2).
    try {
      const parsed = JSON.parse(readFileSync(quarantinePath, "utf8"));
      if (isPlainObject(parsed) && usableCleanupDescriptor(parsed)) quarantine = parsed;
      else markerUnusable = true;
    } catch { markerUnusable = true; }
  }
  const liveMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : undefined;
  const meta = liveMeta || quarantine?.cleanup || {};
  // Compensation metadata is the SPAWN's, from whichever record survived — never
  // a failed retry's report, which says nothing about what still needs undoing.
  if (!liveMeta?.capabilityMeta && quarantine?.cleanup?.capabilityMeta) meta.capabilityMeta = quarantine.cleanup.capabilityMeta;
  // A home with NEITHER instance.json NOR a usable cleanup descriptor cannot be
  // retired safely: hooks would be skipped and the directory removed, which is
  // the credential deletion the quarantine exists to prevent — and the spawn
  // path tolerates a failed marker write, so this state is reachable. Fail
  // closed; `force` is the deliberate manual-cleanup escape.
  // A marker that cannot drive a retry is not "ignore me" — it is evidence that
  // cleanup was interrupted and OAS cannot tell what remains. Fail closed even
  // when instance.json is present; `--force` is the deliberate manual escape.
  if (markerUnusable && !o.force) {
    throw oasError("E_UNIDENTIFIED_INSTANCE_HOME", `${found.home} carries a rollback marker that cannot drive a retry (unreadable, or missing the cleanup descriptor fields the retry consumes), so OAS cannot tell what external state still depends on this home. Inspect it, then re-run with \`--force\` to remove it anyway.`);
  }
  if (!existsSync(metaPath) && !quarantine && !o.force) {
    throw oasError("E_UNIDENTIFIED_INSTANCE_HOME", `${found.home} has no instance.json and no cleanup descriptor, so OAS cannot tell whether external state (identities, worktrees) still depends on it. Retiring it would delete whatever it holds without running any cleanup. Inspect it, then re-run with \`--force\` to remove it anyway.`);
  }

  // `=` forces exact matching: tmux targets otherwise PREFIX-match window names,
  // so retiring "reviewer-1" would kill a live "reviewer-15c135c" window.
  if (!self) shTry(`tmux kill-window -t ${shq(`=${session}:=${name}`)}`);

  // Capability lifecycle hooks (retire) — run BEFORE the dir (and any package state in it,
  // e.g. aweb signing keys) is removed. The knowledge integration harvests notes/ here;
  // the kernel itself is memory-agnostic.
  let hookResults;
  if (meta.repo) {
    const resolved = meta.capabilityRuntime
      ? { capabilities: meta.capabilityRuntime }
      : resolveOasConfig(meta.repo, found.agent.name);
    hookResults = runLifecycleHooks("retire", {
      home: found.home, instance: name, agentName: found.agent.name,
      soulDir: found.agent._soulDir || join(found.agent._dir, "soul"),
      contextDir: meta.repo, workspaceDir: workspaceOf(root), rootDir: root, resolved, priorMeta: meta.capabilityMeta || {},
    });
  }
  const harvested = hookResults?.meta?.["oas.okf"]?.harvested || [];

  const workPath = join(found.home, "work");
  const isWorktree = meta.work === "worktree" ||
    (existsSync(workPath) && !lstatSync(workPath).isSymbolicLink());

  // Lineage repair: any instance pointing at the retiree (parentInstance from a
  // child/parent relation, siblingInstance from a root-sibling link) would be
  // left dangling. Splice the retiree out of the graph: orphans inherit the
  // retiree's COMPLETE surviving lineage — both its parent and its sibling link,
  // whichever edge type pointed at it — so a parent-relation reviewer that
  // retires hands its children back to the parent it displaced at spawn AND
  // restores any sibling cluster link it had absorbed; a link-less retiree's
  // orphans become roots. Relations can cross member repos inside a team
  // deployment (spawn resolves anchors via findTeamInstance), so the scan
  // covers every team agents root. Instance names are only unique per agent
  // dir, so a bare name match is NOT identity: an edge is repaired only when
  // the name, resolved from the ORPHAN's agents root exactly as spawn resolves
  // anchors (local root first, then team scope), lands on the retiring home —
  // which is why the splice runs BEFORE the home is removed.
  const retireeHome = (() => { try { return realpathSync(found.home); } catch { return resolve(found.home); } })();
  const relinked = [];
  const inheritedParent = meta.parentInstance && meta.parentInstance !== name ? meta.parentInstance : undefined;
  const inheritedSibling = meta.siblingInstance && meta.siblingInstance !== name ? meta.siblingInstance : undefined;
  const edgeIsRetiree = (orphanRoot, orphanHome) => {
    if (resolve(orphanHome) === resolve(found.home)) return false; // the retiree itself
    const hit = findInstanceHome(orphanRoot, name) || findTeamInstance(orphanRoot, name);
    if (!hit) return false;
    try { return realpathSync(hit.home) === retireeHome; } catch { return false; }
  };
  const repair = (orphanRoot, instHome) => {
    const p = join(instHome, "instance.json");
    if (!existsSync(p)) return;
    let m; try { m = JSON.parse(readFileSync(p, "utf8")); } catch { return; }
    if (m.parentInstance !== name && m.siblingInstance !== name) return;
    if (!edgeIsRetiree(orphanRoot, instHome)) return; // same NAME, different instance — leave it
    // Drop every edge to the retiree, then graft the retiree's own links —
    // whichever edge TYPE referenced it, the orphan inherits the full slot
    // (parent AND sibling) so clusters stay connected across mixed edge types.
    if (m.parentInstance === name) delete m.parentInstance;
    if (m.siblingInstance === name) delete m.siblingInstance;
    if (!m.parentInstance && inheritedParent && inheritedParent !== m.instance) m.parentInstance = inheritedParent;
    if (!m.siblingInstance && inheritedSibling && inheritedSibling !== m.instance) m.siblingInstance = inheritedSibling;
    writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
    relinked.push({ instance: m.instance, parentInstance: m.parentInstance, siblingInstance: m.siblingInstance });
  };
  const scanRoot = (agentsRoot) => {
    for (const a of listAgents(agentsRoot)) {
      const dir = join(a._dir, "instances");
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) repair(agentsRoot, join(dir, e.name));
    }
    for (const base of localAgentBases(agentsRoot)) {
      if (!existsSync(base)) continue;
      for (const ag of readdirSync(base, { withFileTypes: true })) {
        if (!ag.isDirectory()) continue;
        const dir = join(base, ag.name, "instances");
        if (!existsSync(dir)) continue;
        for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) repair(agentsRoot, join(dir, e.name));
      }
    }
  };
  const roots = new Set();
  try { roots.add(realpathSync(root)); } catch { roots.add(root); } // all-local scopes may lack agents/
  try {
    const cfg = resolveOasConfig(meta.repo || root);
    // Keep nonexistent agents/ roots (all-local sibling scopes): resolve, not drop.
    if (cfg.team) for (const r2 of teamAgentRoots(cfg.team.scope)) { try { roots.add(realpathSync(r2)); } catch { roots.add(resolve(r2)); } }
  } catch { /* no team scope resolvable — local root only */ }
  for (const r2 of roots) scanRoot(r2);

  if (isWorktree && meta.repo) {
    shTry(`git -C ${shq(meta.repo)} worktree remove --force ${shq(workPath)}`);
    shTry(`git -C ${shq(meta.repo)} worktree prune`);
    if (o.deleteBranch && meta.branch) shTry(`git -C ${shq(meta.repo)} branch -D ${shq(meta.branch)}`);
  }
  // Retrying a quarantine only clears it if compensation ACTUALLY completed.
  // Otherwise the home — and the credentials in it — must survive again, or the
  // retry becomes the deletion the quarantine was preventing.
  let stillIncomplete;
  let quarantineBranchDeleted = false;
  if (quarantine) {
    const failures = (hookResults?.failures || []).map((f) => `retire hook ${f.capability}: ${f.message}`);
    // The quarantine may exist BECAUSE Git cleanup failed, so a retry has to
    // redo those steps and verify them — not just rerun hooks. The branch is
    // rollback-owned (spawn created it), so it is deleted here without needing
    // the normal-retire --delete-branch flag, and any failure keeps the home.
    if (meta.work === "worktree" && meta.repo) {
      const gitProbe = (argv) => {
        try { return { ok: true, out: execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
        catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr ?? e2.message ?? "").trim() }; }
      };
      const wtCanonical = realPathOrNearest(workPath);
      gitProbe(["git", "-C", meta.repo, "worktree", "remove", "--force", workPath]);
      gitProbe(["git", "-C", meta.repo, "worktree", "prune"]);
      const wtProbe = gitProbe(["git", "-C", meta.repo, "worktree", "list", "--porcelain", "-z"]);
      if (!wtProbe.ok) failures.push(`git worktree ${wtCanonical}: could not verify removal (${wtProbe.err || "worktree list failed"})`);
      else {
        const registered = wtProbe.out.split("\0").filter((f) => f.startsWith("worktree ")).map((f) => f.slice("worktree ".length));
        if (registered.includes(wtCanonical)) failures.push(`git worktree ${wtCanonical}: still registered`);
      }
      if (meta.branch) {
        gitProbe(["git", "-C", meta.repo, "branch", "-D", meta.branch]);
        const br = gitProbe(["git", "-C", meta.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${meta.branch}`]);
        if (br.ok) failures.push(`git branch ${meta.branch}: still exists`);
        else if (br.status !== 1 || br.err) failures.push(`git branch ${meta.branch}: could not verify deletion (${br.err || `rev-parse exit ${br.status}`})`);
        // Verified gone: the result must say so, or --json misreports the very
        // cleanup this path just performed.
        else quarantineBranchDeleted = true;
      }
    }
    for (const [capId, m] of Object.entries(hookResults?.meta || {})) {
      if (m && typeof m === "object" && m.retired === false && m.reason !== "nothing-to-delete") {
        failures.push(`retire hook ${capId}: reported incomplete cleanup${m.reason ? ` (${m.reason})` : ""}`);
      }
    }
    // The decisive check: not "did anything fail" but "did the work that was
    // outstanding actually happen". A retry that resolves zero capabilities —
    // because the descriptor named none, or config drifted since the spawn —
    // otherwise reports a clean sweep it never performed, and the home and its
    // credential go with it (reviewer-dd03a98).
    const ran = new Set(hookResults?.order || []);
    // Git debt is proven by the verification block above, which only runs for a
    // worktree in a known repo. If it could not run, the debt stands.
    if (quarantine.cleanup.outstanding?.git?.length && !(meta.work === "worktree" && meta.repo)) {
      failures.push(`git ${quarantine.cleanup.outstanding.git.join(", ")}: not re-verified on this retry, so the cleanup they owed is unverified`);
    }
    for (const capId of quarantine.cleanup.outstanding?.hooks || []) {
      if (ran.has(capId)) continue;
      const cap = (meta.capabilityRuntime || []).find((c) => c.id === capId);
      failures.push(cap && !cap.hooks?.retire
        ? `${capId}: declares no retire hook, so OAS cannot verify or undo what its failed spawn hook may have created — clean up by hand, then remove the home with \`oas retire ${name} --force\``
        : `retire hook ${capId}: did not run on this retry, so the cleanup it owed is unverified`);
    }
    if (!hookResults) failures.push("retire hooks could not be rerun (cleanup descriptor lost its context repo)");
    if (failures.length) {
      stillIncomplete = failures;
      try {
        writeFileSync(quarantinePath, JSON.stringify({ ...quarantine, incomplete: failures, lastRetryAt: new Date().toISOString() }, null, 2) + "\n");
      } catch { /* the quarantine stands regardless */ }
    }
  }
  // Forcing is the operator overriding the fail-closed default with their eyes
  // open: the home goes, and what remains outstanding is reported rather than
  // swallowed. Without this, a quarantine whose cleanup can never succeed (a
  // capability that offers no way to undo its own setup, a permanently
  // unreachable remote) would be unremovable through OAS forever — the same
  // dead end the unusable-marker fixes closed, just reached from a valid one.
  const forced = !!(stillIncomplete && o.force);
  if (!o.keepDir && (!stillIncomplete || forced)) rmSync(found.home, { recursive: true, force: true });


  const result = { retired: name, agent: found.agent.name, worktreeRemoved: isWorktree, branchDeleted: !!(o.deleteBranch && meta.branch) || quarantineBranchDeleted, removedDir: !o.keepDir && (!stillIncomplete || forced), rollbackIncomplete: forced ? undefined : stillIncomplete, forcedIncomplete: forced ? stillIncomplete : undefined, retainedHome: stillIncomplete && !forced ? found.home : undefined, harvested, relinked: relinked.length ? relinked : undefined, capabilityMeta: hookResults?.meta, warnings: hookResults?.warnings?.length ? hookResults.warnings : undefined };
  if (self) {
    // The caller is the instance: its process lives in the window we are about to
    // kill. Detach the kill so this function can return and the caller can report
    // before dying. The delay is the caller's window to print its last words.
    shTry(`tmux run-shell -b 'sleep ${o.selfKillDelaySec ?? 8}; tmux kill-window -t ${shq(`=${session}:=${name}`)} 2>/dev/null || true'`);
    result.selfKillScheduled = true;
  }
  return result;
}
