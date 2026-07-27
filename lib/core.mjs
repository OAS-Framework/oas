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
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync,
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
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) add(loadManifestAt(join(dir, e.name), origin));
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
      loadDir(join(store, INSTALLED_SUBDIR), `installed:${cfg._level}`);
      // Package-exported capabilities: index ONLY the oas.json dirs each installed
      // package's oas-package.json enumerates (explicit resource indexing, no
      // ambient loading). They share the `installed:` origin so `from: installed`
      // keeps its meaning; _package/_packageSource carry provenance.
      const pkgStore = installedPackagesDir(cfg._level);
      if (existsSync(pkgStore)) {
        const locks = levelLockV2(cfg._level);
        for (const e of readdirSync(pkgStore, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          const pdir = join(pkgStore, e.name);
          if (!existsSync(join(pdir, "oas-package.json"))) continue;
          let pm;
          try { pm = loadPackageManifestAt(pdir); } catch { continue; /* doctor reports broken installed packages */ }
          for (const c of pm._capabilities) {
            add({ ...c.manifest, _origin: `installed:${cfg._level}`, _package: pm.package, _packageDir: pdir, _packageSource: locks[pm.package]?.source });
          }
        }
      }
      // Annotate marketplace-sourced installs (their lock source is marketplace:<id>@<version>):
      // they may resolve framework-hoisted resources and are trusted at acquisition.
      const lockFile = join(cfg._level, OAS_LOCK_FILE);
      {
        // Strict parse; a broken lock must not silently drop the marketplace
        // annotation (discovery raises; doctor catches the typed error).
        const strict = parseLockFileStrict(lockFile);
        if (strict) {
          for (const m of Object.values(out)) {
            if (m._origin === `installed:${cfg._level}` && String(strict.capabilities[m.capability]?.source || "").startsWith("marketplace:")) m._marketplace = true;
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

/** Stable package integrity over relative paths and file bytes; VCS and generated lock metadata are excluded. */
export function capabilityIntegrity(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === OAS_LOCK_FILE) continue;
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
    for (const [id, lock] of Object.entries(strict.capabilities)) {
      // Retirement wins over entry-shape validation here too: retired entries
      // are surfaced for their actionable migration diagnostic (doctor/CLI),
      // never consumed for trust — capabilityTrust rejects retired ids upstream.
      if (!retiredCapabilityReason(id)) {
        const violation = residueEntryViolation(lock);
        if (violation) throw oasError("invalid-lock", `${file}: legacy entry "${id}" is malformed (${violation})`, [{ file, package: id, violation }]);
      }
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
  const parsed = strict
    ? { lockfileVersion: strict.version, packages: strict.version === 2 ? { ...strict.packages } : undefined, capabilities: { ...strict.capabilities } }
    : { lockfileVersion: 1, capabilities: {} };
  if (parsed.packages === undefined) delete parsed.packages;
  // Never downgrade a v2 (package) lock. Residue rules (runtime API addendum §6):
  // in a v2 file, legacy entries may only be UPDATED (exact-integrity restore/
  // trust servicing) — never synthesized; only `oas migrate` creates residue.
  if (parsed.lockfileVersion === 2) {
    if (!(parsed.capabilities || {})[id]) throw oasError("legacy-lock", `${file} is lockfileVersion 2 — legacy capability locks cannot be added here ("${id}" is not existing migration residue); install a package instead`);
    parsed.lockfileVersion = 2;
  } else parsed.lockfileVersion = 1;
  parsed.capabilities ||= {}; parsed.capabilities[id] = lock;
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
  return file;
}

/** Keep acquired artifacts uncommitted (like node_modules) while owned/ commits. No-op outside version control. */
export function ensureInstalledGitignore(levelDir) {
  const inRepo = spawnSyncOk("git", ["-C", levelDir, "rev-parse", "--is-inside-work-tree"]);
  if (!inRepo) return false;
  const store = join(levelDir, CAPABILITIES_DIRNAME);
  const file = join(store, ".gitignore");
  const line = `${INSTALLED_SUBDIR}/`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === line)) return false;
  mkdirSync(store, { recursive: true });
  writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + `# OAS: acquired capabilities are restored from oas-lock.json by \`oas install\`.\n${line}\n`);
  return true;
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
      cpSync(rootSnapshot.dir, dest, { recursive: true });
      if (existsSync(join(dest, "oas-package.json")) !== rootSnapshot.package || existsSync(join(dest, "oas.json")) !== rootSnapshot.capability || !rootSnapshot.capability || rootSnapshot.package) {
        throw oasError("invalid-source", `inspected Git root layout changed before standalone capability acquisition: ${src}`);
      }
    } else if (isUrl) execFileSync("git", ["clone", "-q", src, dest], { stdio: "inherit" });
    else execFileSync("cp", ["-R", from, dest]);
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
    for (const [id, lock] of Object.entries(strict.capabilities)) {
      // Retirement wins over EVERYTHING (including entry-shape validation):
      // the actionable migration diagnostic must never be masked by a shape
      // complaint about an entry the user is being told to delete anyway.
      const retiredReason = retiredCapabilityReason(id);
      if (retiredReason) { report.push({ id, level, status: "retired", reason: retiredReason }); continue; }
      const violation = residueEntryViolation(lock);
      if (violation) throw oasError("invalid-lock", `${file}: legacy entry "${id}" is malformed (${violation})`, [{ file, package: id, violation }]);
      const present = capabilityManifest(id, startDir);
      if (present) { report.push({ id, level, status: "present", dir: present._dir }); continue; }
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
    // Package-exported capability: trust binds to the provider package's exact
    // locked integrity + per-capability approval (contract §7) — AND the
    // materialized runtime-dependency digest, so post-approval tampering of
    // node_modules invalidates trust like source drift.
    const locks = readPackageLocks(startDir).packages; // raises invalid-lock (fail closed — only doctor catches)
    if (!Object.hasOwn(locks, manifest._package)) return { trusted: false, reason: `provider package ${manifest._package} is not locked in ${OAS_LOCK_FILE}` };
    const entry = locks[manifest._package];
    // readPackageLocks above already performed the strict full-map semantic
    // validation and RAISED invalid-lock if violated (fail closed; only doctor
    // catches that typed error) — no swallowing here.
    const integrity = packageIntegrity(manifest._packageDir);
    if (entry.integrity !== integrity) return { trusted: false, reason: `package ${manifest._package} integrity differs from ${entry._file}`, integrity, lock: entry };
    const depsNow = packageDepsIntegrity(manifest._packageDir);
    if ((entry.depsIntegrity || undefined) !== depsNow) {
      return { trusted: false, reason: `package ${manifest._package} materialized dependency tree differs from the locked runtime closure — restore or update explicitly`, integrity, lock: entry };
    }
    if (executable && !(entry.trustedCapabilities || []).includes(manifest.capability)) {
      return { trusted: false, reason: `executable commands/hooks need \`oas trust ${manifest.capability}\``, integrity, lock: entry };
    }
    return { trusted: true, integrity, depsIntegrity: depsNow, lock: entry, package: manifest._package };
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

export const PACKAGES_DIRNAME = join(".agents", "packages");
export const installedPackagesDir = (level) => join(level, PACKAGES_DIRNAME, INSTALLED_SUBDIR);

/** Keep installed package roots uncommitted, like the capability store. */
export function ensurePackagesGitignore(levelDir) {
  // Convenience only: acquisition is already committed when this runs, so a
  // read-only/malformed VCS ignore file must never turn success into a
  // post-commit exception. The lock is authoritative; ignore maintenance is
  // best-effort and may be repaired by a later invocation.
  try {
    const inRepo = spawnSyncOk("git", ["-C", levelDir, "rev-parse", "--is-inside-work-tree"]);
    if (!inRepo) return false;
    const store = join(levelDir, PACKAGES_DIRNAME);
    const file = join(store, ".gitignore");
    const line = `${INSTALLED_SUBDIR}/`;
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === line)) return false;
    mkdirSync(store, { recursive: true });
    writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + `# OAS: installed packages are restored from oas-lock.json by \`oas install\`.\n${line}\n`);
    return true;
  } catch { return false; }
}

/** Parse + normalize a package source spec (contract §1): git shorthand, raw
 * git URL, local path, or official catalog short ID. */
export function parsePackageSource(spec, { baseDir } = {}) {
  const s = String(spec ?? "").trim();
  if (!s) throw oasError("invalid-source", "empty package source");
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
    return { kind: "path", path: p, relative: relativeSpec, normalized: `path:${p}` };
  };
  if (s.startsWith("path:")) return asPath(s.slice(5));
  if (s.startsWith(".") || s.startsWith("/") || s.startsWith("~")) return asPath(s);
  if (s.startsWith("git:") && !s.startsWith("git://")) {
    const [body, ref] = splitRef(s.slice(4));
    if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(body)) throw oasError("invalid-source", `git shorthand must be git:host/org/repo[@ref]: "${spec}"`);
    const url = `https://${body}${body.endsWith(".git") ? "" : ".git"}`;
    return { kind: "git", url, ref, normalized: ref ? `git:${url}@${ref}` : `git:${url}` };
  }
  if (/^(https?:\/\/|file:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s)) {
    const [url, ref] = splitRef(s);
    return { kind: "git", url, ref, normalized: ref ? `git:${url}@${ref}` : `git:${url}` };
  }
  const m = /^([a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(s);
  if (m) return { kind: "catalog", id: m[1], selector: m[2], normalized: m[2] ? `catalog:${m[1]}@${m[2]}` : `catalog:${m[1]}` };
  throw oasError("invalid-source", `"${spec}" is not a git source, local path, or official catalog id`);
}

/** Inspect only a Git source's fetched ROOT layout before choosing package vs
 * legacy capability acquisition. No scope/lock preflight or mutation occurs. */
export function inspectGitSourceRoot(spec) {
  const parsed = parsePackageSource(spec);
  if (parsed.kind !== "git") throw oasError("invalid-source", `Git root inspection requires a Git source: ${spec}`);
  const tmp = mkdtempSync(join(tmpdir(), "oas-git-root-"));
  const root = join(tmp, "root");
  try {
    const { commit } = fetchPackageSource(parsed, root);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw oasError("invalid-source", `Git inspection did not resolve an exact commit for ${spec}`);
    return {
      package: existsSync(join(root, "oas-package.json")), capability: existsSync(join(root, "oas.json")),
      commit, dir: root, cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
}

function parseLockSource(src) {
  const s = String(src || "");
  if (s.startsWith("path:")) return { kind: "path", path: s.slice(5), normalized: s };
  if (s.startsWith("catalog:")) {
    const body = s.slice(8);
    const at = body.lastIndexOf("@");
    return { kind: "catalog", id: at > 0 ? body.slice(0, at) : body, selector: at > 0 ? body.slice(at + 1) || undefined : undefined, normalized: s };
  }
  if (s.startsWith("git:")) {
    const body = s.slice(4);
    const at = body.lastIndexOf("@") > body.lastIndexOf("/") ? body.lastIndexOf("@") : -1;
    return { kind: "git", url: at > 0 ? body.slice(0, at) : body, ref: at > 0 ? body.slice(at + 1) : undefined, normalized: s };
  }
  throw oasError("invalid-source", `unknown lock source "${src}"`);
}

/** Official package catalog: identity + discovery ONLY — resolving through it
 * never advances a lock and never grants executable trust (contract §1).
 * Workstream 3 seeds the kernel-bundled catalog; OAS_PACKAGE_CATALOG points
 * tests/deployments at an alternate catalog JSON ({ packages: { <id>: { url, ref? } } }). */
export function officialPackageCatalog() {
  const file = process.env.OAS_PACKAGE_CATALOG || join(PKG_ROOT, "package-catalog.json");
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")).packages || {}; }
  catch (e) { throw oasError("invalid-source", `broken package catalog ${file}: ${e.message}`); }
}
function defaultCatalogResolve(id, selector) {
  const e = officialPackageCatalog()[id];
  if (!e || !e.url) return undefined;
  return { url: e.url, ref: selector || e.ref };
}

/** Stable package integrity: like capabilityIntegrity but also excludes
 * materialized runtime deps (node_modules), so `npm ci --ignore-scripts`
 * materialization never changes the locked hash. */
export function packageIntegrity(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === OAS_LOCK_FILE || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { hash.update(relative(dir, p)); hash.update("\0file\0"); hash.update(readFileSync(p)); hash.update("\0"); }
      else if (e.isSymbolicLink()) { hash.update(relative(dir, p)); hash.update("\0symlink\0"); hash.update(readlinkSync(p)); hash.update("\0"); }
    }
  };
  walk(dir);
  return `sha256-${hash.digest("hex")}`;
}

/** Deterministic digest of the MATERIALIZED runtime dependency closure: every
 * node_modules tree under the package root (which packageIntegrity excludes).
 * Returns undefined when no node_modules exists (empty closure). Trust binds
 * approvals to this digest so post-approval tampering of materialized deps
 * invalidates trust like any other integrity drift. */
export function packageDepsIntegrity(dir) {
  const hash = createHash("sha256");
  let found = false;
  const walk = (d, inDeps) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === OAS_LOCK_FILE) continue;
      const p = join(d, e.name);
      const nowIn = inDeps || e.name === "node_modules";
      if (e.isDirectory()) { walk(p, nowIn); continue; }
      if (!nowIn) continue;
      if (e.isFile()) { found = true; hash.update(relative(dir, p)); hash.update("\0file\0"); hash.update(readFileSync(p)); hash.update("\0"); }
      else if (e.isSymbolicLink()) { found = true; hash.update(relative(dir, p)); hash.update("\0symlink\0"); hash.update(readlinkSync(p)); hash.update("\0"); }
    }
  };
  walk(dir, false);
  return found ? `sha256-${hash.digest("hex")}` : undefined;
}

const PACKAGE_MANIFEST_KEYS = new Set(["package", "version", "description", "compatibility", "capabilities", "configs", "dependencies"]);
/** Load + validate an oas-package.json (schema semantics of docs/oas-package.schema.json,
 * plus containment: every declared path must stay inside the package root after
 * symlink resolution and identify the expected resource kind). Returns the
 * manifest with _dir and _capabilities: [{ id, rel, dir, manifest }]. */
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
  const caps = [];
  const seen = new Map();
  if (m.capabilities !== undefined && (!Array.isArray(m.capabilities) || m.capabilities.some((c) => typeof c !== "string"))) throw oasError("invalid-package-manifest", `package ${m.package} "capabilities" must be an array of package-relative directories`);
  // Flat single-capability packages: "." means the package root IS the capability
  // dir — it cannot be combined with other capability paths (nesting).
  if ((m.capabilities || []).includes(".") && m.capabilities.length > 1) throw oasError("invalid-package-manifest", `package ${m.package} lists "." (flat single-capability layout) together with other capability paths — "." must be the only entry`);
  for (const rel of m.capabilities || []) {
    const dir = inside(rel, "capability");
    if (!existsSync(join(dir, "oas.json"))) throw oasError("invalid-package-manifest", `package ${m.package} capability path ${rel} has no oas.json (not a capability)`);
    const cm = loadManifestAt(dir, `package:${m.package}`);
    const retiredReason = retiredCapabilityReason(cm.capability);
    if (retiredReason) throw oasError("retired-capability", `package ${m.package} exports retired capability "${cm.capability}" — ${retiredReason}`);
    if (seen.has(cm.capability)) throw oasError("duplicate-capability-id", `package ${m.package} exports capability "${cm.capability}" from both ${seen.get(cm.capability)} and ${rel}`, [seen.get(cm.capability), rel]);
    seen.set(cm.capability, rel);
    caps.push({ id: cm.capability, rel, dir, manifest: cm });
  }
  if (m.configs !== undefined && (m.configs === null || typeof m.configs !== "object" || Array.isArray(m.configs))) throw oasError("invalid-package-manifest", `package ${m.package} "configs" must be a map of profile name → { path, description?, default? }`);
  let defaults = 0;
  const PROFILE_KEYS = new Set(["path", "description", "default"]);
  for (const [name, prof] of Object.entries(m.configs || {})) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw oasError("invalid-package-manifest", `package ${m.package} config profile name "${name}" is invalid`);
    if (!prof || typeof prof !== "object" || Array.isArray(prof) || typeof prof.path !== "string" || !prof.path) throw oasError("invalid-package-manifest", `package ${m.package} config profile "${name}" needs a string path`);
    const extraProf = Object.keys(prof).filter((k) => !PROFILE_KEYS.has(k));
    if (extraProf.length) throw oasError("invalid-package-manifest", `package ${m.package} config profile "${name}" has unknown keys: ${extraProf.join(", ")}`);
    if (prof.description !== undefined && typeof prof.description !== "string") throw oasError("invalid-package-manifest", `package ${m.package} config profile "${name}" description must be a string`);
    if (prof.default !== undefined && typeof prof.default !== "boolean") throw oasError("invalid-package-manifest", `package ${m.package} config profile "${name}" default must be a boolean`);
    const p = inside(prof.path, `config profile "${name}"`);
    if (!lstatSync(p).isFile()) throw oasError("invalid-package-manifest", `package ${m.package} config profile "${name}" path is not a file: ${prof.path}`);
    if (prof.default) defaults++;
  }
  if (defaults > 1) throw oasError("invalid-package-manifest", `package ${m.package} marks ${defaults} config profiles as default (at most one)`);
  if (m.dependencies !== undefined && (!Array.isArray(m.dependencies) || m.dependencies.some((d) => typeof d !== "string"))) throw oasError("invalid-package-manifest", `package ${m.package} "dependencies" must be an array of package source specs`);
  if (m.dependencies && new Set(m.dependencies).size !== m.dependencies.length) throw oasError("invalid-package-manifest", `package ${m.package} "dependencies" contains duplicates`);
  if (m.capabilities && new Set(m.capabilities).size !== m.capabilities.length) throw oasError("invalid-package-manifest", `package ${m.package} "capabilities" contains duplicates`);
  return { ...m, _dir: pdir, _capabilities: caps };
}

/** Read the merged package locks visible from a directory's config chain
 * (closest scope wins per identity). Legacy v1 capability locks (and v2
 * migration residue) are surfaced separately, untouched. */
const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const LOCK_ENTRY_KEYS = new Set(["source", "version", "commit", "integrity", "depsIntegrity", "capabilities", "dependencies", "trustedCapabilities"]);
/** ONE strict lock parser (reviewer-5f1188d): reads + validates root shape,
 * lockfile version, packages-map shape and keys, entry shapes (full semantic
 * pass incl. the dependency graph), and the residue container. EVERY violation
 * is a typed invalid-lock with provenance. Returns
 * { version, packages(null-proto, validated), capabilities } or null when the
 * file does not exist. Used by readPackageLocks, levelLockV2, and restore. */
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
  // Residue/legacy container shape (present on either version).
  if (parsed.capabilities !== undefined && (parsed.capabilities === null || typeof parsed.capabilities !== "object" || Array.isArray(parsed.capabilities))) {
    throw bad(`"capabilities" must be an object map (got ${parsed.capabilities === null ? "null" : Array.isArray(parsed.capabilities) ? "array" : typeof parsed.capabilities})`);
  }
  const capabilities = parsed.capabilities || {};
  // Validate the COMPLETE residue/legacy map before ANY consumer sees it.
  // Retirement intentionally wins over shape validation (the user is told to
  // delete that entry), but every non-retired entry is strict. This makes
  // restore preflight atomic and prevents malformed residue from granting the
  // marketplace/hoisted-path exemption during discovery (reviewer-12e2d86).
  for (const [id, entry] of Object.entries(capabilities)) {
    if (retiredCapabilityReason(id)) continue;
    const violation = residueEntryViolation(entry);
    if (violation) throw bad(`legacy entry "${id}" is malformed (${violation})`, { package: id });
  }
  const out = { version: v ?? 1, packages: Object.create(null), capabilities };
  if ((v ?? 1) === 2) {
    if (parsed.packages === undefined || parsed.packages === null || typeof parsed.packages !== "object" || Array.isArray(parsed.packages)) {
      throw bad(`lockfileVersion 2 requires a "packages" object map (got ${parsed.packages === undefined ? "undefined" : parsed.packages === null ? "null" : Array.isArray(parsed.packages) ? "array" : typeof parsed.packages})`);
    }
    for (const id of Object.keys(parsed.packages)) {
      if (!PACKAGE_ID_RE.test(id)) throw bad(`packages map has an invalid package key ${JSON.stringify(id)}`, { package: id });
      const e = parsed.packages[id];
      if (!e || typeof e !== "object" || Array.isArray(e)) throw bad(`lock entry for "${id}" is not an object`, { package: id });
      const extra = Object.keys(e).filter((k) => !LOCK_ENTRY_KEYS.has(k));
      if (extra.length) throw bad(`lock entry for "${id}" has unknown keys: ${extra.join(", ")}`, { package: id });
      out.packages[id] = e;
    }
    for (const [id, e] of Object.entries(out.packages)) validateLockEntry(id, e, out.packages, { file });
  }
  return out;
}
/** Read the merged package locks visible from a directory's config chain
 * (closest scope wins per identity). FAIL-CLOSED (maintainer finding 3):
 * malformed JSON, invalid package-map keys, or non-object entries RAISE
 * invalid-lock — consumers must not treat bad locks as absent. Doctor catches
 * the typed error and diagnoses. The packages map is null-prototype and keys
 * are validated, so raw-JSON __proto__/constructor keys cannot forge entries. */
export function readPackageLocks(startDir) {
  const out = { packages: Object.create(null), legacy: [] };
  // Discovery includes LOCK-OWNING scopes even when no config exists there
  // (maintainer ruling): walk every ancestor dir carrying an oas-lock.json,
  // merged with config-chain levels, outermost → innermost (closest wins).
  const levels = [];
  for (let d = resolve(startDir); ; d = dirname(d)) {
    if (existsSync(join(d, OAS_LOCK_FILE))) levels.push(d);
    if (dirname(d) === d) break;
  }
  for (const cfg of configChain(startDir)) if (existsSync(join(cfg._level, OAS_LOCK_FILE)) && !levels.includes(cfg._level)) levels.push(cfg._level);
  for (const level of [...levels].reverse()) {
    const file = join(level, OAS_LOCK_FILE);
    const strict = parseLockFileStrict(file); // ONE strict parser — typed invalid-lock on any violation
    if (!strict) continue;
    for (const [id, e] of Object.entries(strict.packages)) out.packages[id] = { ...e, _file: file, _level: level };
    // Empty v1 locks SURFACE (maintainer ruling): every discovered
    // lockfileVersion:1 file appears in legacy — including {capabilities:{}} —
    // with provenance; a v2 file appears only when it carries nonempty residue.
    if (strict.version !== 2 || Object.keys(strict.capabilities).length) {
      out.legacy.push({ file, level, lockfileVersion: strict.version, capabilities: strict.capabilities });
    }
  }
  return out;
}

/** Write/replace (entry) or delete (entry === null) one package's lock entry.
 * Creates a lockfileVersion 2 file; refuses to write packages into a pure v1
 * lock — the explicit migration command owns that version flip. */
export function writePackageLock(levelDir, packageId, entry) {
  const file = join(levelDir, OAS_LOCK_FILE);
  // ONE central lock-document parser BEFORE any mutation (maintainer 2nd
  // detector-round item): malformed JSON / null / scalar / array roots and
  // wrong-typed packages/capabilities maps are typed invalid-lock with file
  // provenance — no raw SyntaxError/TypeError, no legacy-lock misclass.
  const strict = parseLockFileStrict(file);
  if (strict && strict.version !== 2) throw oasError("legacy-lock", `${file} is lockfileVersion ${strict.version} — run \`oas migrate\` at this scope before locking packages`);
  const parsed = strict
    ? { lockfileVersion: 2, packages: { ...strict.packages }, ...(Object.keys(strict.capabilities).length ? { capabilities: strict.capabilities } : {}) }
    : { lockfileVersion: 2, packages: {} };
  if (typeof packageId !== "string" || !PACKAGE_ID_RE.test(packageId)) throw oasError("invalid-lock", `invalid package identity ${JSON.stringify(packageId)} (must be a string matching the package-id grammar)`);
  if (entry === null) delete parsed.packages[packageId];
  else parsed.packages[packageId] = entry;
  // Validate the FULL prospective map before writing (maintainer finding 3):
  // an invalid lock must never be produced by the writer. Entries whose
  // dependencies are not yet in the map (mid-closure writes) are validated
  // without the graph check by passing a map that includes themselves.
  const prospective = Object.create(null);
  for (const id of Object.keys(parsed.packages)) {
    if (!PACKAGE_ID_RE.test(id)) throw oasError("invalid-lock", `${file} packages map has an invalid package key ${JSON.stringify(id)}`);
    prospective[id] = parsed.packages[id];
  }
  for (const [id, e] of Object.entries(prospective)) {
    // Mid-closure tolerance: skip dependency-existence for ids being written
    // later in the same acquire transaction is NOT needed — acquire writes
    // dependencies before dependents (post-order), so the map is always
    // self-consistent at every write.
    validateLockEntry(id, e, prospective, { file });
  }
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
  return file;
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
 * v2/v3 packages maps only; v1 fails closed. */
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
      if (e.name === ".git") continue;
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

export function materializePackageDeps(dir) {
  let roots = [dir];
  try { roots = [...new Set([dir, ...loadPackageManifestAt(dir)._capabilities.map((c) => realpathSync(c.dir))].map((d) => { try { return realpathSync(d); } catch { return d; } }))]; } catch { /* bare dir (no oas-package.json): treat as single root */ }
  const lockRoots = roots.filter((root) => existsSync(join(root, "package-lock.json")) && existsSync(join(root, "package.json")));
  // TRANSACTION-WIDE PREFLIGHT (reviewer-11752b2): scan EVERY materialization
  // root's lockfile BEFORE any npm ci runs, so a clean package-root closure
  // cannot materialize ahead of a rejected per-capability lock.
  const preflight = [];
  for (const root of lockRoots) {
    const variant = platformVariantLockPackages(join(root, "package-lock.json"));
    if (variant.length) preflight.push(`platform-variant runtime closure in ${root}: ${variant.join(", ")} — v1 requires platform-invariant closures (vendor a pure-JS dependency or drop it)`);
  }
  if (preflight.length) return { materialized: false, roots: [], error: preflight.join("; ") };
  const materialized = [];
  const errors = [];
  for (const root of lockRoots) {
    try {
      // Maintainer ruling: production tree only — dev AND host peer deps omitted;
      // packages reach host peer APIs only through the supported host boundary.
      execFileSync("npm", ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "ignore", timeout: 300000 });
      materialized.push(root);
    } catch (e) {
      errors.push(`npm ci --ignore-scripts failed in ${root}: ${e.message}`);
    }
  }
  return { materialized: materialized.length > 0, roots: materialized, error: errors.length ? errors.join("; ") : undefined };
}

/** Platform-invariance preflight for an already-installed package root (used
 * by acquire's kept/no-op path, where materialization is skipped but a
 * prohibited pre-existing closure must still fail — reviewer-11752b2). */
export function assertPlatformInvariantLocks(dir) {
  let roots = [dir];
  try { roots = [...new Set([dir, ...loadPackageManifestAt(dir)._capabilities.map((c) => realpathSync(c.dir))].map((d) => { try { return realpathSync(d); } catch { return d; } }))]; } catch { /* bare dir */ }
  for (const root of roots) {
    if (!existsSync(join(root, "package-lock.json")) || !existsSync(join(root, "package.json"))) continue;
    const variant = platformVariantLockPackages(join(root, "package-lock.json"));
    if (variant.length) throw oasError("invalid-package-manifest", `platform-variant runtime closure in ${root}: ${variant.join(", ")} — v1 requires platform-invariant closures (vendor a pure-JS dependency or drop it)`);
  }
}

/** Symlink containment for materialized dependency trees (maintainer finding 4):
 * every symlink under every node_modules below root must realpath-resolve
 * INSIDE the package root; broken or escaping links throw path-escape. Run
 * after npm ci and BEFORE any digest/swap. */
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
      if (e.name === ".git") continue;
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

function fetchPackageSource(parsed, dest, catalog, { commit } = {}) {
  if (parsed.kind === "catalog") {
    const r = (catalog || defaultCatalogResolve)(parsed.id, parsed.selector);
    if (!r || !r.url) throw oasError("invalid-source", `the official package catalog cannot resolve "${parsed.id}${parsed.selector ? `@${parsed.selector}` : ""}"`);
    return fetchPackageSource({ kind: "git", url: r.url, ref: r.ref }, dest, catalog, { commit });
  }
  if (parsed.kind === "git") {
    execFileSync("git", ["clone", "-q", parsed.url, dest], { stdio: "pipe" });
    const ref = commit || parsed.ref;
    if (ref) execFileSync("git", ["-C", dest, "checkout", "-q", ref], { stdio: "pipe" });
    return { commit: execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
  }
  if (!existsSync(parsed.path)) throw oasError("invalid-source", `local package path does not exist: ${parsed.path}`);
  if (!existsSync(join(parsed.path, "oas-package.json"))) throw oasError("invalid-package-manifest", `${parsed.path} has no oas-package.json distribution manifest`);
  cpSync(parsed.path, dest, { recursive: true });
  return { commit: "local" };
}

function levelLockV2(levelDir) {
  const strict = parseLockFileStrict(join(levelDir, OAS_LOCK_FILE));
  return strict && strict.version === 2 ? strict.packages : Object.create(null);
}

/** Resolve + acquire a package closure at one scope (contract §3): fetch the
 * root source, validate manifests, resolve dependencies (official selector /
 * pinned git / local path — no semver solver), detect cycles and identity
 * collisions, exact-lock everything. Activates nothing. Transactional: staged
 * under the store, validated completely, then artifacts + lock land together. */
export function acquirePackage(levelDir, spec, opts = {}) {
  const lockFile = join(levelDir, OAS_LOCK_FILE);
  {
    // ONE strict parser (root shape, version, map shapes) — a null/scalar/array
    // root is typed invalid-lock, never a TypeError or legacy-lock misclass.
    const strict = parseLockFileStrict(lockFile);
    if (strict && strict.version !== 2 && Object.keys(strict.capabilities).length) {
      throw oasError("legacy-lock", `${lockFile} is lockfileVersion ${strict.version} — run \`oas migrate\` at this scope before installing packages`);
    }
  }
  const storeRoot = installedPackagesDir(levelDir);
  const staging = join(levelDir, PACKAGES_DIRNAME, `.staging-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(staging, { recursive: true });
  const resolved = new Map(); // identity → { dir, manifest, source, commit, integrity, deps, capabilities }
  let counter = 0;
  const resolveClosure = (srcSpec, chain, baseDir) => {
    const p = parsePackageSource(srcSpec, { baseDir });
    const dest = join(staging, `pkg-${counter++}`);
    let commit;
    if (!chain.length && opts.rootSnapshot) {
      cpSync(opts.rootSnapshot.dir, dest, { recursive: true });
      commit = opts.rootSnapshot.commit;
      const packageLayout = existsSync(join(dest, "oas-package.json"));
      const capabilityLayout = existsSync(join(dest, "oas.json"));
      if (packageLayout !== opts.rootSnapshot.package || capabilityLayout !== opts.rootSnapshot.capability || !packageLayout) {
        throw oasError("invalid-source", `inspected Git root layout changed before package acquisition for ${srcSpec}`);
      }
    } else ({ commit } = fetchPackageSource(p, dest, opts.catalog));
    const m = loadPackageManifestAt(dest);
    const id = m.package;
    if (chain.includes(id)) throw oasError("dependency-cycle", `package dependency cycle: ${[...chain, id].join(" → ")}`, [...chain, id]);
    // Preserve the ORIGINAL catalog spec in lock metadata: bare and explicit
    // selector forms must remain distinguishable for update. The resolved git
    // commit is already pinned separately in `commit`.
    const source = p.kind === "catalog" ? (p.selector ? `catalog:${p.id}@${p.selector}` : `catalog:${p.id}`) : p.kind === "path" ? p.normalized : `git:${p.url}@${p.ref || commit}`;
    if (resolved.has(id)) {
      const prev = resolved.get(id);
      if (prev.source !== source) throw oasError("duplicate-package-identity", `two sources claim package "${id}" at ${levelDir}: ${prev.source} and ${source}`, [prev.source, source]);
      rmSync(dest, { recursive: true, force: true });
      return id;
    }
    const compat = capabilityCompatibility(m);
    if (!compat.compatible) throw oasError("incompatible-oas", `package ${id} requires OAS ${compat.range} (running ${OAS_VERSION})`);
    const deps = [];
    for (const d of m.dependencies || []) {
      // Relative local-path dependencies resolve against the DEPENDING
      // PACKAGE'S source root (contract intent: package-relative), never the
      // process CWD. For git/catalog parents there is no local base.
      const depBase = p.kind === "path" ? p.path : undefined;
      const dp = parsePackageSource(d, { baseDir: depBase });
      if (dp.kind === "git" && !dp.ref) throw oasError("invalid-source", `package dependency must be pinned to a tag/commit: "${d}" (declared by ${id})`);
      // EVERY relative path dependency requires a local base — classified from
      // the parsed payload so "path:sub" / whitespace spellings cannot resolve
      // through the process CWD from a git/catalog manifest (reviewer-2a4adec).
      if (dp.kind === "path" && dp.relative && !depBase) throw oasError("invalid-source", `package dependency "${d}" (declared by ${id}) is a relative path, but ${id} was not acquired from a local path — relative dependencies only work between co-located local packages`);
      deps.push(resolveClosure(d, [...chain, id], depBase));
    }
    resolved.set(id, { dir: dest, manifest: m, source, commit, integrity: packageIntegrity(dest), deps, capabilities: m._capabilities });
    return id;
  };
  try {
    const rootId = resolveClosure(spec, [], undefined);
    if (opts.expectPackage && rootId !== opts.expectPackage) {
      throw oasError("duplicate-package-identity", `source ${spec} no longer provides root package "${opts.expectPackage}" (root resolved to "${rootId}")`);
    }
    // Same-scope capability collisions: within the closure, and against
    // already-installed packages at this level not replaced by this closure.
    const capOwner = new Map();
    const existingLock = levelLockV2(levelDir);
    // Residue collision (addendum §6): a legacy residue capability ID colliding
    // with a package-exported capability at this scope is an error — no implicit
    // winner, no dual trust path.
    const residue = (() => {
      try { const p = JSON.parse(readFileSync(lockFile, "utf8")); return p.lockfileVersion === 2 ? Object.keys(p.capabilities || {}) : []; } catch { return []; }
    })();
    // ...against the incoming closure:
    for (const [pid, r] of resolved) {
      for (const c of r.capabilities) {
        if (residue.includes(c.id)) throw oasError("duplicate-capability-id", `capability "${c.id}" exported by package "${pid}" collides with legacy migration residue at ${lockFile} — finish or remove the residue entry first (re-run \`oas migrate\`)`, [`residue:${lockFile}`, pid]);
      }
    }
    // ...and against RETAINED already-locked packages outside this closure
    // (mixed-v2 scopes with locks predating this check must not keep a
    // prohibited package/residue dual path alive through unrelated acquires):
    for (const [pid, e] of Object.entries(existingLock)) {
      if (resolved.has(pid)) continue;
      for (const c of e.capabilities || []) {
        if (residue.includes(c)) throw oasError("duplicate-capability-id", `capability "${c}" exported by locked package "${pid}" collides with legacy migration residue at ${lockFile} — finish or remove the residue entry first (re-run \`oas migrate\`)`, [`residue:${lockFile}`, pid]);
      }
    }
    for (const [pid, e] of Object.entries(existingLock)) {
      if (resolved.has(pid)) continue;
      for (const c of e.capabilities || []) capOwner.set(c, pid);
    }
    for (const [pid, r] of resolved) {
      for (const c of r.capabilities) {
        if (capOwner.has(c.id) && capOwner.get(c.id) !== pid) throw oasError("duplicate-capability-id", `capability "${c.id}" is exported by both package "${capOwner.get(c.id)}" and package "${pid}" at ${levelDir}`, [capOwner.get(c.id), pid]);
        capOwner.set(c.id, pid);
      }
    }
    // Pre-validate destinations before any rename so the commit phase cannot half-apply.
    mkdirSync(storeRoot, { recursive: true });
    const actions = [];
    for (const [pid, r] of resolved) {
      const dest = join(storeRoot, pid);
      // Lock-record invariant (WS2/coordinator finding 5): when a same-scope
      // lock entry exists, the RECORDED integrity must also match — source and
      // installed trees drifting to the SAME bytes must not re-legitimize the
      // drifted artifact against the existing lock. Explicit `oas update`
      // (opts.replace) is the only advancement path.
      const prior = Object.hasOwn(existingLock, pid) ? existingLock[pid] : undefined;
      if (prior && !opts.replace && prior.integrity !== r.integrity) {
        throw oasError("integrity-drift", `package "${pid}" resolves to integrity ${r.integrity} but the existing lock records ${prior.integrity} — a locked source never advances on acquire; use \`oas update ${pid}\``);
      }
      if (existsSync(dest)) {
        if (packageIntegrity(dest) === r.integrity) {
          const observedDeps = packageDepsIntegrity(dest);
          // A true keep requires BOTH installed digests to match the prior
          // lock. Never bless/advance depsIntegrity from an observed runtime
          // tree: a mismatch is repaired from staged source below.
          if (prior && (prior.depsIntegrity || undefined) === observedDeps) {
            actions.push({ pid, r, dest, keep: true, prior, observedDeps });
            continue;
          }
          actions.push({ pid, r, dest, replace: true, repair: true, prior });
          continue;
        }
        if (!opts.replace) throw new Error(`package "${pid}" is already installed at ${dest} with different content — OAS never silently updates a locked package; use \`oas update ${pid}\``);
        actions.push({ pid, r, dest, replace: true, prior });
      } else actions.push({ pid, r, dest, prior });
    }
    // Materialize runtime deps IN STAGING (before any destination mutation) and
    // bind the materialized-closure digest; a materialization failure fails the
    // whole transaction with nothing changed. TRANSACTION-WIDE preflight first:
    // scan EVERY action's lockfiles (kept AND fresh) so a clean root cannot
    // materialize before a later action's rejection, and a kept/no-op path
    // cannot carry a prohibited pre-existing closure (reviewer-11752b2).
    for (const a of actions) assertPlatformInvariantLocks(a.keep ? a.dest : a.r.dir);
    const deps = [];
    for (const a of actions) {
      if (a.keep) {
        // Even an exact-digest keep traverses current runtime containment and
        // native-binary policy; digest equality is not a reason to skip safety.
        assertMaterializedDepsContained(a.dest);
        assertNoNativeBinaries(a.dest);
        a.depsIntegrity = a.prior.depsIntegrity;
        continue;
      }
      const rep = materializePackageDeps(a.r.dir);
      if (rep.error) throw oasError("invalid-package-manifest", `runtime dependency materialization failed for package "${a.pid}": ${rep.error}`);
      // Symlink containment BEFORE digest/swap (finding 4).
      assertMaterializedDepsContained(a.r.dir);
      assertNoNativeBinaries(a.r.dir); // .node scan (maintainer ruling item 3)
      a.depsIntegrity = packageDepsIntegrity(a.r.dir);
      // Plain acquire may repair a tampered/missing installed tree, but it may
      // never advance the locked runtime digest. Only explicit update/replace
      // may do that.
      if (a.prior && !opts.replace && (a.prior.depsIntegrity || undefined) !== a.depsIntegrity) {
        throw oasError("integrity-drift", `package "${a.pid}" materializes dependency integrity ${a.depsIntegrity || "(none)"} but the existing lock records ${a.prior.depsIntegrity || "(none)"} — acquire never advances a locked runtime closure; use \`oas update ${a.pid}\``);
      }
    }
    // COMMIT: swap artifacts with backups, then write the lock once; any
    // failure rolls the store and lock back to the pre-operation state.
    const originalLock = existsSync(lockFile) ? readFileSync(lockFile, "utf8") : null;
    const done = []; // { dest, backup? }
    try {
      for (const a of actions) {
        if (a.keep) continue;
        let backup;
        if (a.replace) { backup = join(staging, `backup-${a.pid}`); renameSync(a.dest, backup); }
        renameSync(a.r.dir, a.dest);
        done.push({ dest: a.dest, backup });
      }
      for (const a of actions) {
        const prior = existingLock[a.pid];
        const trustedCapabilities = prior && prior.integrity === a.r.integrity && (prior.depsIntegrity || undefined) === a.depsIntegrity ? prior.trustedCapabilities || [] : [];
        writePackageLock(levelDir, a.pid, {
          source: a.r.source, version: a.r.manifest.version, commit: a.r.commit, integrity: a.r.integrity,
          ...(a.depsIntegrity ? { depsIntegrity: a.depsIntegrity } : {}),
          capabilities: a.r.capabilities.map((c) => c.id), dependencies: a.r.deps, trustedCapabilities,
        });
      }
    } catch (e) {
      for (const d of done.reverse()) {
        rmSync(d.dest, { recursive: true, force: true });
        if (d.backup && existsSync(d.backup)) renameSync(d.backup, d.dest);
      }
      if (originalLock === null) rmSync(lockFile, { force: true });
      else writeFileSync(lockFile, originalLock);
      throw e;
    }
    const installed = actions.map((a) => ({ package: a.pid, version: a.r.manifest.version, commit: a.r.commit, integrity: a.r.integrity, source: a.r.source, capabilities: a.r.capabilities.map((c) => c.id), dir: a.dest, kept: !!a.keep }));
    ensurePackagesGitignore(levelDir);
    return { root: rootId, installed, lockFile, depWarnings: deps };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Semantic v2 lock-entry validation (runtime API addendum §4; maintainer
 * ruling): trust subset, dependency references (incl. self/cycle over the
 * locked graph), source/commit pairing, uniqueness. Run BEFORE restore,
 * trust/approval, update/remove planning, and doctor/list consumption. Fails
 * closed with code "invalid-lock" carrying file/package provenance; never
 * normalizes or auto-repairs on read. */
export function validateLockEntry(packageId, entry, allPackages = {}, opts = {}) {
  const where = opts.file ? ` (${opts.file})` : "";
  const bad = (msg) => oasError("invalid-lock", `lock entry for package "${packageId}"${where} is invalid: ${msg}`, [{ package: packageId, file: opts.file, violation: msg }]);
  if (!entry || typeof entry !== "object") throw bad("not an object");
  for (const k of ["source", "version", "commit", "integrity"]) if (!entry[k] || typeof entry[k] !== "string") throw bad(`missing ${k}`);
  if (!/^sha256-[0-9a-f]{64}$/.test(entry.integrity)) throw bad(`malformed integrity "${entry.integrity}"`);
  if (!Array.isArray(entry.capabilities)) throw bad("missing capabilities list");
  // Present-but-wrong-typed optional fields are invalid — default ONLY when absent.
  for (const field of ["dependencies", "trustedCapabilities"]) {
    if (entry[field] !== undefined && !Array.isArray(entry[field])) throw bad(`${field} must be an array`);
  }
  if (entry.depsIntegrity !== undefined && (typeof entry.depsIntegrity !== "string" || !/^sha256-[0-9a-f]{64}$/.test(entry.depsIntegrity))) throw bad(`malformed depsIntegrity ${JSON.stringify(entry.depsIntegrity)}`);
  // Every array ITEM must satisfy the schema: strings only; dependency ids
  // must match the package-identity grammar (no coercion anywhere).
  for (const c of entry.capabilities) if (typeof c !== "string" || !c) throw bad(`capabilities contains a non-string entry ${JSON.stringify(c)}`);
  for (const t of entry.trustedCapabilities ?? []) if (typeof t !== "string" || !t) throw bad(`trustedCapabilities contains a non-string entry ${JSON.stringify(t)}`);
  for (const d of entry.dependencies ?? []) if (typeof d !== "string" || !PACKAGE_ID_RE.test(d)) throw bad(`dependencies contains an invalid package id ${JSON.stringify(d)}`);
  for (const [field, list] of [["capabilities", entry.capabilities], ["dependencies", entry.dependencies ?? []], ["trustedCapabilities", entry.trustedCapabilities ?? []]]) {
    if (new Set(list).size !== list.length) throw bad(`${field} contains duplicates`);
  }
  let src;
  try { src = parseLockSource(entry.source); } catch (e) { throw bad(`unrecognized source "${entry.source}"`); }
  if (src.kind === "path" && !src.path) throw bad("empty path source");
  if (src.kind === "git" && !src.url) throw bad("empty git source");
  if (src.kind === "catalog" && !src.id) throw bad("empty catalog source");
  if (src.kind === "path") { if (entry.commit !== "local") throw bad(`path source requires commit "local", got "${entry.commit}"`); }
  else if (!/^[0-9a-f]{40}$/.test(entry.commit)) throw bad(`${src.kind} source requires an exact 40-hex commit, got "${entry.commit}"`);
  const caps = new Set(entry.capabilities);
  for (const t of entry.trustedCapabilities || []) if (!caps.has(t)) throw bad(`trustedCapabilities entry "${t}" is not in capabilities`);
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

function verifyLockedCapabilities(dir, id, lock) {
  const m = loadPackageManifestAt(dir);
  const have = m._capabilities.map((c) => c.id).sort();
  const want = [...(lock.capabilities || [])].sort();
  if (have.join("\n") !== want.join("\n")) throw oasError("capability-list-mismatch", `package ${id}: locked capabilities [${want.join(", ")}] do not match the manifest's [${have.join(", ")}]`);
}

/** Restore every locked package in the lockfile chain at its exact commit +
 * integrity (contract §3). Transactional per package: fetched to staging,
 * verified, then swapped in. Never advances a ref. NO team-boundary recursion. */
export function restorePackages(startDir, opts = {}) {
  const report = [];
  const levels = [];
  for (let d = resolve(startDir); ; d = dirname(d)) {
    if (existsSync(join(d, OAS_LOCK_FILE))) levels.push(d);
    if (dirname(d) === d) break;
  }
  // Validate/cache every visible scope before any package fetch, staging, or
  // swap. Restore is fail-closed across the whole chain, not merely per file.
  const locks = levels.reverse().map((level) => {
    const file = join(level, OAS_LOCK_FILE);
    return { level, file, strict: parseLockFileStrict(file) };
  });
  for (const { level, file, strict } of locks) {
    if (!strict) continue;
    if (strict.version !== 2) {
      if (Object.keys(strict.capabilities).length) report.push({ package: null, level, status: "legacy", reason: `lockfileVersion ${strict.version} — capability locks restore via the legacy path; \`oas migrate\` adopts packages` });
      continue;
    }
    const strictMap = strict.packages;
    for (const [id, lock] of Object.entries(strictMap)) {
      const dest = join(installedPackagesDir(level), id);
      const staging = join(level, PACKAGES_DIRNAME, `.restore-${process.pid}-${Date.now().toString(36)}`);
      try {

        if (existsSync(dest) && packageIntegrity(dest) === lock.integrity && (lock.depsIntegrity || undefined) === packageDepsIntegrity(dest)) {
          verifyLockedCapabilities(dest, id, lock);
          report.push({ package: id, level, status: "ok", dir: dest });
          continue;
        }
        const src = parseLockSource(lock.source);
        const tmp = join(staging, "pkg");
        mkdirSync(staging, { recursive: true });
        fetchPackageSource(src, tmp, opts.catalog, { commit: src.kind === "git" || src.kind === "catalog" ? lock.commit : undefined });
        const integ = packageIntegrity(tmp);
        if (integ !== lock.integrity) throw oasError("integrity-drift", `restored package ${id} integrity ${integ} does not match locked ${lock.integrity}; the source has drifted — reacquire explicitly`);
        verifyLockedCapabilities(tmp, id, lock);
        // Materialize + verify the runtime closure IN STAGING before the swap.
        const mrep = materializePackageDeps(tmp);
        if (mrep.error) throw oasError("integrity-drift", `restored package ${id}: runtime dependency materialization failed — ${mrep.error}`);
        assertMaterializedDepsContained(tmp);
        assertNoNativeBinaries(tmp);
        const depsNow = packageDepsIntegrity(tmp);
        if ((lock.depsIntegrity || undefined) !== depsNow) throw oasError("integrity-drift", `restored package ${id} materialized dependency closure ${depsNow || "(none)"} does not match locked ${lock.depsIntegrity || "(none)"}`);
        // Swap with backup so a rename failure cannot lose the prior artifact.
        const replaced = existsSync(dest);
        const backup = join(staging, "backup");
        if (replaced) renameSync(dest, backup);
        mkdirSync(dirname(dest), { recursive: true });
        try { renameSync(tmp, dest); }
        catch (e) { if (replaced) renameSync(backup, dest); throw e; }
        report.push({ package: id, level, status: "restored", dir: dest, replaced });
      } catch (e) {
        report.push({ package: id, level, status: "failed", reason: e.message, code: e.code });
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  return report;
}

/** Enumerate installed packages visible from a directory (closest scope wins
 * per identity) and the capabilities each exports, with provenance. Two
 * same-scope packages exporting one capability ID is an error. */
export function listInstalledPackages(startDir) {
  const byId = new Map();
  for (const cfg of [...configChain(startDir)].reverse()) {
    const level = cfg._level;
    const store = installedPackagesDir(level);
    // Strict per-level validation happens even when the store dir is absent:
    // a lock with only missing artifacts (e.g. ghost entries) must still fail
    // closed here, not render ok (maintainer finding 3 / reviewer-f832ba9).
    const locks = levelLockV2(level); // raises invalid-lock on any violation
    if (!existsSync(store)) continue;
    const capOwner = new Map();
    for (const e of readdirSync(store, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = join(store, e.name);
      if (!existsSync(join(dir, "oas-package.json"))) continue;
      const m = loadPackageManifestAt(dir);
      const l = Object.hasOwn(locks, m.package) ? locks[m.package] : undefined;
      for (const c of m._capabilities) {
        if (capOwner.has(c.id)) throw oasError("duplicate-capability-id", `capability "${c.id}" is exported by both package "${capOwner.get(c.id)}" and package "${m.package}" at ${level}`, [capOwner.get(c.id), m.package]);
        capOwner.set(c.id, m.package);
      }
      byId.set(m.package, {
        package: m.package, version: m.version, level, dir,
        source: l?.source, commit: l?.commit, integrity: l?.integrity, locked: !!l,
        dependencies: l?.dependencies || [], trustedCapabilities: l?.trustedCapabilities || [],
        capabilities: m._capabilities.map((c) => ({ id: c.id, dir: c.dir, manifest: c.manifest })),
        manifest: m,
      });
    }
  }
  return [...byId.values()];
}

/** Approve executable surfaces (contract §3): per-capability by default;
 * allCapabilities treats `id` as a package identity and is the explicit bulk
 * path (the CLI shows the full executable-surface summary first). Approval is
 * bound to the provider package's exact locked integrity; any integrity change
 * resets trustedCapabilities to []. Non-executable capabilities need no approval. */
export function approveCapability(startDir, id, { allCapabilities } = {}) {
  const locks = readPackageLocks(startDir).packages;
  const pkgs = listInstalledPackages(startDir);
  const pkg = allCapabilities ? pkgs.find((p) => p.package === id) : pkgs.find((p) => p.capabilities.some((c) => c.id === id));
  if (!pkg) throw oasError("unknown-capability", allCapabilities ? `no installed package "${id}"` : `no installed package exports capability "${id}"`);
  const entry = locks[pkg.package];
  if (!entry) throw oasError("unknown-capability", `package ${pkg.package} is not locked in ${OAS_LOCK_FILE} — run \`oas install\``);
  {
    const { _file, _level, ...clean0 } = entry;
    validateLockEntry(pkg.package, clean0, levelLockV2(_level), { file: _file });
  }
  const integrity = packageIntegrity(pkg.dir);
  if (integrity !== entry.integrity) throw oasError("integrity-drift", `package ${pkg.package} integrity changed (${entry.integrity} → ${integrity}); reacquire or update explicitly before trusting`);
  const depsNow = packageDepsIntegrity(pkg.dir);
  if ((entry.depsIntegrity || undefined) !== depsNow) throw oasError("integrity-drift", `package ${pkg.package} materialized dependency closure changed — restore or update explicitly before trusting`);
  const surface = {};
  for (const c of pkg.capabilities) surface[c.id] = { commands: Object.keys(c.manifest.commands || {}), hooks: Object.keys(c.manifest.hooks || {}) };
  const targets = allCapabilities ? pkg.capabilities.map((c) => c.id) : [id];
  const executableTargets = targets.filter((t) => surface[t].commands.length || surface[t].hooks.length);
  const { _file, _level, ...clean } = entry;
  const trusted = new Set(clean.trustedCapabilities || []);
  for (const t of executableTargets) trusted.add(t);
  clean.trustedCapabilities = [...trusted].sort();
  const file = writePackageLock(_level, pkg.package, clean);
  return { package: pkg.package, integrity, approved: executableTargets, skipped: targets.filter((t) => !executableTargets.includes(t)), executableSurface: surface, file };
}

/** Transactional package update (contract §3, Decision §8): temp re-resolve of
 * the full closure from the package's ORIGINAL spec (or opts.spec), complete
 * validation, diff computed, then artifact + lock replaced together. All
 * capability approvals of changed packages are invalidated by the integrity
 * change (acquirePackage carries approvals over only at identical integrity). */
export function updatePackage(startDir, packageId, opts = {}) {
  const locks = readPackageLocks(startDir).packages;
  const entry = locks[packageId];
  if (!entry) throw oasError("unknown-capability", `package "${packageId}" is not locked in any ${OAS_LOCK_FILE} in this chain`);
  {
    const { _file, _level, ...clean } = entry;
    const map = levelLockV2(_level);
    // Validate EVERY entry the update closure/planning can consume (reviewer
    // finding): an invalid dependency entry must fail closed BEFORE acquire
    // rewrites/preserves it.
    for (const [pid, e] of Object.entries(map)) validateLockEntry(pid, e, map, { file: _file });
  }
  const level = entry._level;
  const src = parseLockSource(entry.source);
  // Re-resolve from the un-pinned identity: catalog id (fresh selector), git url
  // at its recorded ref (tags may move; unpinned = default branch), or path.
  const spec = opts.spec || (src.kind === "catalog" ? (src.selector ? `${src.id}@${src.selector}` : src.id) : src.kind === "git" ? (src.ref && !/^[0-9a-f]{40}$/.test(src.ref) ? `${src.url}@${src.ref}` : src.url) : src.path);
  const before = { version: entry.version, commit: entry.commit, integrity: entry.integrity, capabilities: entry.capabilities || [], trustedCapabilities: entry.trustedCapabilities || [] };
  // expectPackage makes identity change a PRE-COMMIT failure inside
  // acquirePackage (nothing installed/locked if the source renamed itself).
  const r = acquirePackage(level, spec, { ...opts, replace: true, expectPackage: packageId });
  const after = r.installed.find((p) => p.package === packageId);
  if (!after) throw oasError("duplicate-package-identity", `source ${spec} no longer provides package "${packageId}" (root resolved to "${r.root}")`);
  const changed = after.integrity !== before.integrity;
  return {
    package: packageId, level, changed, before, after,
    installed: r.installed, depWarnings: r.depWarnings,
    addedCapabilities: after.capabilities.filter((c) => !before.capabilities.includes(c)),
    removedCapabilities: before.capabilities.filter((c) => !after.capabilities.includes(c)),
    invalidatedApprovals: changed ? before.trustedCapabilities : [],
  };
}

/** Remove one installed package: refuses while other locked packages depend on
 * it or any config in the chain references a capability it exports (Decision §8). */
export function removePackage(startDir, packageId) {
  const locks = readPackageLocks(startDir).packages;
  const entry = locks[packageId];
  if (!entry) throw oasError("unknown-capability", `package "${packageId}" is not locked in any ${OAS_LOCK_FILE} in this chain`);
  const ownMap = levelLockV2(entry._level);
  {
    const { _file, _level, ...clean } = entry;
    validateLockEntry(packageId, clean, ownMap, { file: _file });
  }
  const blockers = [];
  // Dependents are a property of the TARGET ENTRY'S OWN complete scope map.
  // The closest-wins merged chain can hide an outer dependent behind an inner
  // package with the same id and must never authorize removal.
  for (const [pid, e] of Object.entries(ownMap)) {
    if (pid !== packageId && (e.dependencies || []).includes(packageId)) blockers.push(`package "${pid}" (locked in ${entry._file}) depends on it`);
  }
  const exported = new Set(entry.capabilities || []);
  for (const cfg of configChain(startDir)) {
    for (const { id, slot } of configCapabilityEntries(cfg)) {
      if (exported.has(id)) blockers.push(`${cfg._file} references capability "${id}"${slot ? ` (${slot} layer)` : ""}`);
    }
  }
  if (blockers.length) {
    const e = oasError("remove-blocked", `cannot remove package "${packageId}":\n  - ${blockers.join("\n  - ")}\nRemove the config references / dependent packages first.`, blockers);
    throw e;
  }
  const dir = join(installedPackagesDir(entry._level), packageId);
  const backup = join(entry._level, PACKAGES_DIRNAME, `.remove-${packageId}-${process.pid}-${Date.now().toString(36)}`);
  const originalLock = readFileSync(entry._file, "utf8");
  const hadArtifact = existsSync(dir);
  try {
    if (hadArtifact) renameSync(dir, backup);
    writePackageLock(entry._level, packageId, null);
    if (hadArtifact) rmSync(backup, { recursive: true, force: true });
  } catch (e) {
    // Roll back BOTH sides if validation/write/removal fails after the artifact
    // move. Preserve the original lock bytes and installed path.
    try { if (readFileSync(entry._file, "utf8") !== originalLock) writeFileSync(entry._file, originalLock); } catch { /* preserve original failure */ }
    if (hadArtifact && existsSync(backup)) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(backup, dir);
    }
    throw e;
  }
  return { package: packageId, level: entry._level, dir, lockFile: entry._file };
}

/** Validate one legacy (v1/residue) capability lock entry against the v1
 * schema shape; returns null when valid or a violation string. Shared by
 * doctor human + JSON so both diagnose the same set (addendum §6). */
export function residueEntryViolation(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "not an object";
  for (const k of ["source", "version", "integrity"]) if (typeof entry[k] !== "string" || !entry[k]) return `missing/invalid ${k}`;
  if (!/^sha256-[0-9a-f]{64}$/.test(entry.integrity)) return `malformed integrity "${entry.integrity}"`;
  if (entry.commit !== undefined && typeof entry.commit !== "string") return "invalid commit";
  if (entry.trustedExecutables !== undefined && typeof entry.trustedExecutables !== "boolean") return "invalid trustedExecutables";
  return null;
}

/** Map a legacy v1 lock at one scope to a v2 package plan (contract §3). Pure
 * mapping: the migration command applies it. marketplace:<id> entries map to
 * official catalog specs (package id == capability id for official packages);
 * git/path entries map to package sources; unmappable entries stay as residue. */
/** Atomic file replacement: write to a same-directory temp file, flush, then
 * rename over the destination — an interrupted write leaves the original
 * bytes intact (reviewer-21849d4). */
function atomicWriteFileSync(file, content) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function migrateLegacyLock(levelDir, opts = {}) {
  const file = join(levelDir, OAS_LOCK_FILE);
  const plan = [];
  const warnings = [];
  if (!existsSync(file)) return { plan, warnings: ["no oas-lock.json at this scope"] };
  // Central strict parse: malformed roots/maps are typed invalid-lock (the
  // strict parser also validates v2 packages-map shape; migrate's own version
  // predicate below handles versions unsupported FOR MIGRATION).
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { throw oasError("invalid-lock", `${file}: malformed JSON — ${e.message}`, [{ file, violation: "malformed JSON" }]); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw oasError("invalid-lock", `${file}: lock root must be a JSON object`, [{ file, violation: "malformed root" }]);
  if (parsed.capabilities !== undefined && (parsed.capabilities === null || typeof parsed.capabilities !== "object" || Array.isArray(parsed.capabilities))) throw oasError("invalid-lock", `${file}: "capabilities" must be an object map`, [{ file, violation: "malformed capabilities container" }]);
  if (parsed.lockfileVersion === 2) parseLockFileStrict(file); // full v2 shape validation (raises invalid-lock)
  const catalog = opts.catalog || defaultCatalogResolve;
  // Empty v1 lock: trivially convertible — dry-run reports the format flip,
  // never "nothing found" (maintainer ruling). STRICTLY v1 only: unknown
  // versions or malformed shapes fail closed, never silently rewritten
  // (reviewer-21849d4: a lockfileVersion:3 file must not be destroyed).
  const emptyCaps = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && (parsed.capabilities === undefined || (typeof parsed.capabilities === "object" && parsed.capabilities !== null && !Array.isArray(parsed.capabilities) && !Object.keys(parsed.capabilities).length));
  const isV1 = parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.lockfileVersion === 1 || parsed.lockfileVersion === undefined) && parsed.packages === undefined;
  if (parsed?.lockfileVersion !== 2 && !isV1) {
    throw oasError("invalid-lock", `${file} has unsupported lockfileVersion ${JSON.stringify(parsed?.lockfileVersion)} — migration only converts valid v1 locks; fix or remove the file`, [{ file, violation: "unsupported version for migration" }]);
  }
  if (isV1 && emptyCaps) {
    plan.push({ capabilityId: null, v1: null, package: null, action: "convert-format", note: `empty lockfileVersion ${parsed.lockfileVersion ?? 1} → canonical v2 {packages:{}} (no residue)` });
    return { plan, warnings };
  }
  for (const [capId, v1] of Object.entries(parsed.capabilities || {})) {
    // Retirement wins before entry-shape validation, matching the central
    // parser and restore/doctor behavior. Never dereference a malformed entry.
    const retiredReason = retiredCapabilityReason(capId);
    if (retiredReason) { plan.push({ capabilityId: capId, v1, package: null, action: "manual" }); warnings.push(`${capId}: retired — ${retiredReason}`); continue; }
    // Schema-invalid residue/legacy entries are typed invalid-lock BEFORE any
    // field is coerced into a migration plan (reviewer-c44b73c: an array
    // source must never normalize into a usable spec).
    const violation = residueEntryViolation(v1);
    if (violation) throw oasError("invalid-lock", `${file}: legacy entry "${capId}" is malformed (${violation}) — fix or remove it before migrating`, [{ file, package: capId, violation }]);
    const src = v1.source; // validated string by residueEntryViolation above
    if (src.startsWith("marketplace:")) {
      const id = src.slice("marketplace:".length).replace(/@[^@]*$/, "");
      const selector = v1.version ? `v${v1.version}` : undefined;
      if (catalog(id, selector)) plan.push({ capabilityId: capId, v1, package: { id, source: src, spec: selector ? `${id}@${selector}` : id }, action: "acquire" });
      else { plan.push({ capabilityId: capId, v1, package: { id, source: src, spec: selector ? `${id}@${selector}` : id }, action: "manual" }); warnings.push(`${capId}: official package "${id}" is not in the package catalog yet — kept as legacy residue`); }
    } else if (src.startsWith("git:")) {
      const url = src.slice(4);
      const spec = v1.commit ? `${url}@${v1.commit}` : url;
      if (!v1.commit) warnings.push(`${capId}: v1 lock has no commit — the migration acquire will resolve and pin the source's current state`);
      plan.push({ capabilityId: capId, v1, package: { id: null, source: src, spec }, action: "acquire" });
    } else if (src.startsWith("path:")) {
      plan.push({ capabilityId: capId, v1, package: { id: null, source: src, spec: src.slice(5) }, action: "acquire" });
    } else {
      plan.push({ capabilityId: capId, v1, package: null, action: "manual" });
      warnings.push(`${capId}: unknown v1 source "${src}" — migrate manually`);
    }
  }
  return { plan, warnings };
}

/** Apply a migrateLegacyLock plan at one scope: acquire mapped packages,
 * verify each expected capability is actually exported, flip lockfileVersion
 * to 2, and retain unmappable v1 entries as legacy residue in the v2 file
 * (config `from: installed` activation is preserved either way — the spelling
 * does not change). Executable approvals are NOT carried over: package
 * integrity differs from the v1 capability artifact, so trust is re-earned. */
export function applyLegacyLockMigration(levelDir, opts = {}) {
  const file = join(levelDir, OAS_LOCK_FILE);
  if (!existsSync(file)) throw oasError("legacy-lock", `no ${OAS_LOCK_FILE} at ${levelDir}`);
  const original = readFileSync(file, "utf8");
  let parsed;
  try { parsed = JSON.parse(original); }
  catch (e) { throw oasError("invalid-lock", `${file}: malformed JSON — ${e.message}`, [{ file, violation: "malformed JSON" }]); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw oasError("invalid-lock", `${file}: lock root must be a JSON object`, [{ file, violation: "malformed root" }]);
  // Re-running migrate on a v2 lock retries its RESIDUE entries (later
  // successful conversion once the catalog can map them). Strict validation
  // MUST precede the no-residue fast path; malformed v2 cannot masquerade as
  // already complete (reviewer-fe42de8).
  const v2Rerun = parsed?.lockfileVersion === 2;
  const strictV2 = v2Rerun ? parseLockFileStrict(file) : null;
  if (v2Rerun && !Object.keys(strictV2.capabilities).length) return { migrated: [], residue: [], warnings: ["already lockfileVersion 2 (no residue)"] };
  // Empty v1: trivially convertible — ATOMIC canonical v2 replacement (temp +
  // rename; an interrupted write preserves the original bytes). Strictly v1:
  // migrateLegacyLock (below, also called for the plan) rejects unknown
  // versions with invalid-lock before any write.
  const isV1Empty = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && (parsed.lockfileVersion === 1 || parsed.lockfileVersion === undefined) && parsed.packages === undefined
    && (parsed.capabilities === undefined || (typeof parsed.capabilities === "object" && parsed.capabilities !== null && !Array.isArray(parsed.capabilities) && !Object.keys(parsed.capabilities).length));
  if (!v2Rerun) migrateLegacyLock(levelDir, opts); // raises invalid-lock for unsupported versions/shapes before ANY write
  if (isV1Empty) {
    atomicWriteFileSync(file, JSON.stringify({ lockfileVersion: 2, packages: {} }, null, 2) + "\n");
    return { migrated: [], residue: [], warnings: [], file, formatConverted: true };
  }
  const { plan, warnings } = migrateLegacyLock(levelDir, opts);
  // ATOMIC (addendum §6 / maintainer constraint 7): flip the version so
  // acquirePackage accepts the scope, convert every mappable entry, and on ANY
  // conversion failure restore the original v1 lock and remove every package
  // installed by this migration — the original lock/store is left unchanged.
  writeFileSync(file, JSON.stringify({ lockfileVersion: 2, packages: parsed.packages || {}, capabilities: parsed.capabilities || {} }, null, 2) + "\n");
  const migrated = [];
  const residue = [];
  const installedDirs = [];
  const removedCapDirs = []; // deferred: capability artifacts are deleted only after full success
  try {
    for (const step of plan) {
      if (step.action !== "acquire") { residue.push(step.capabilityId); continue; }
      // Remove the v1 entry FIRST so the residue-collision check doesn't fire
      // against the entry being converted (rollback restores it on failure).
      const pre = JSON.parse(readFileSync(file, "utf8"));
      delete pre.capabilities[step.capabilityId];
      writeFileSync(file, JSON.stringify(pre, null, 2) + "\n");
      const r = acquirePackage(levelDir, step.package.spec, opts);
      // Record EVERY artifact this conversion created BEFORE validating the
      // provider — a failing validation must roll back the failing package's
      // closure too, not only earlier conversions.
      for (const p of r.installed) if (!p.kept) installedDirs.push(p.dir);
      const provider = r.installed.find((p) => p.capabilities.includes(step.capabilityId));
      if (!provider) throw oasError("capability-list-mismatch", `migrated source ${step.package.spec} does not export capability "${step.capabilityId}"`);
      const capStore = installedCapabilitiesDir(levelDir);
      if (existsSync(capStore)) {
        for (const e of readdirSync(capStore, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const cdir = join(capStore, e.name);
          try { if (JSON.parse(readFileSync(join(cdir, "oas.json"), "utf8")).capability === step.capabilityId) removedCapDirs.push(cdir); } catch { /* not a capability dir */ }
        }
      }
      migrated.push({ capability: step.capabilityId, package: provider.package, version: provider.version });
    }
  } catch (e) {
    // Roll back: original v1 lock byte-identical; migration-installed packages removed.
    writeFileSync(file, original);
    for (const d of installedDirs) rmSync(d, { recursive: true, force: true });
    throw oasError(e.code || "legacy-lock", `migration failed and was rolled back (original v1 lock restored): ${e.message}`, e.provenance);
  }
  // Full success: superseded v1 capability artifacts are removed now.
  for (const d of removedCapDirs) rmSync(d, { recursive: true, force: true });
  return { migrated, residue, warnings, file };
}

/** Unmet external requirements of a capability. */
export function capabilityMissingRequires(name, startDir) {
  const m = capabilityManifest(name, startDir);
  return (m?.requires || []).filter((r) => r.command && !which(r.command));
}

/** Resolve a manifest-relative path; only marketplace-sourced packages may use framework-hoisted resources. */
function manifestPath(manifest, rel) {
  const local = join(manifest._dir, rel);
  if (existsSync(local)) {
    // Package-exported capabilities are contained by the locked PACKAGE root
    // (+ materialized deps within it); standalone capabilities by their own dir.
    const root = realpathSync(manifest._packageDir || manifest._dir); const target = realpathSync(local); const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`capability ${manifest.capability} path escapes its integrity boundary: ${rel}`);
    }
    return local;
  }
  // Only marketplace (framework-shipped) packages may intentionally use hoisted/shared framework resources.
  if (manifest._marketplace) {
    const hoisted = join(REPO_ROOT, rel);
    if (existsSync(hoisted)) return hoisted;
  }
  return undefined;
}
/** Resolve an executable declared by a manifest through the same artifact boundary as hooks. */
export function capabilityExecutablePath(manifest, rel) { return manifestPath(manifest, rel); }
function assertCapabilityTreeContained(manifest, tree, resource = "skill") {
  // Marketplace-sourced installs may reference framework-hoisted trees (outside the copy).
  const manifestRoot = realpathSync(manifest._dir);
  const treeReal = realpathSync(tree);
  const fromManifest = relative(manifestRoot, treeReal);
  if (manifest._marketplace && (fromManifest === ".." || fromManifest.startsWith(`..${sep}`) || isAbsolute(fromManifest))) return;
  const artifact = realpathSync(manifest._packageDir || manifest._dir);
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
    cpSync(realpathSync(selected.src), join(home, ".agents", "skills", name), { recursive: true });
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
          outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg, hookMeta: compMeta,
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
function quarantineInstanceHome({ home, instance, agent, incomplete, failed, outstandingHooks, outstandingGit, repoAbs, work, branch, resolvedCfg, hookMeta }) {
  try {
    writeFileSync(join(home, ".oas-rollback-incomplete.json"), JSON.stringify({
      instance, agent: agent.name, reason: "spawn rolled back and compensation did not complete",
      // Capability/hook names and cleanup diagnostics only — never hook output.
      failed, incomplete, retainedFor: "credentials/metadata needed to retry cleanup",
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
  if (!existsSync(metaPath) && existsSync(quarantinePath)) {
    // A marker without a USABLE cleanup descriptor is NOT a quarantine we can
    // retry — it is an unidentified home. Treating an unusable one as retryable
    // made --force unable to ever clear it: the retry could not run, so the home
    // was retained again, forever (reviewer-adff009). "Parses as JSON" is not
    // the bar; "can actually drive the retry" is, so the shape is checked
    // against what the retry below consumes (reviewer-45ff039r2).
    try {
      const parsed = JSON.parse(readFileSync(quarantinePath, "utf8"));
      if (isPlainObject(parsed) && usableCleanupDescriptor(parsed)) quarantine = parsed;
    } catch { /* malformed: falls through to the unidentified-home guard */ }
  }
  const meta = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, "utf8"))
    : (quarantine?.cleanup || {});
  // A home with NEITHER instance.json NOR a usable cleanup descriptor cannot be
  // retired safely: hooks would be skipped and the directory removed, which is
  // the credential deletion the quarantine exists to prevent — and the spawn
  // path tolerates a failed marker write, so this state is reachable. Fail
  // closed; `force` is the deliberate manual-cleanup escape.
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
