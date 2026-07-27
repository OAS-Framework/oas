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
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const RESERVED = new Set(["bin", "local-agents", "tmp-agents"]);
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
export function ensureRoot(cwd) {
  const root = findRoot(cwd);
  if (!root) {
    throw new Error(
      `no agents/ or local-agents/ directory found walking up from ${resolve(cwd ?? process.cwd())} — create one (mkdir agents, or \`oas create <name> --local\`) or set PI_AGENTS_ROOT`,
    );
  }
  return root;
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
  cfg._level = dir; cfg._file = file;
  return cfg;
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
function manifestHookCommands(manifest) {
  const out = {};
  for (const [ev, cmd] of Object.entries(manifest?.hooks || {})) {
    if (!APPROVED_HOOKS.has(ev) || typeof cmd !== "string") continue;
    const [script, ...args] = cmd.split(/\s+/);
    const abs = manifestPath(manifest, script);
    if (abs) out[ev] = ["node", shq(abs), ...args].join(" ");
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
      hooks: trust.trusted ? manifestHookCommands(manifest) : {},
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
  for (const hook of Object.keys(m.hooks || {})) if (!APPROVED_HOOKS.has(hook)) throw new Error(`capability ${id} declares unsupported hook "${hook}"`);
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

/** Restore every locked capability in the chain whose artifact is missing. Walks lockfiles (a lock can exist at a scope without a config). Returns a report list. */
export function restoreCapabilities(startDir) {
  const report = [];
  const levels = [];
  for (let d = resolve(startDir); ; d = dirname(d)) {
    if (existsSync(join(d, OAS_LOCK_FILE))) levels.push(d);
    if (dirname(d) === d) break;
  }
  // Preflight/cache the COMPLETE visible chain before the first restore. A
  // malformed inner lock must not be discovered after an outer artifact was
  // already installed (reviewer-fe42de8).
  const locks = levels.reverse().map((level) => {
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
export function capabilitySkillDirs(name, startDir) {
  const m = capabilityManifest(name, startDir);
  if (!m?.skills) return [];
  return m.skills.map((s) => manifestPath(m, s)).filter(Boolean).map((tree) => {
    assertCapabilityTreeContained(m, tree);
    return tree;
  });
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
 * aweb's Claude Code channel plugin — contributes its flags this way). Failures never block.
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
          OAS_EVENT: event, OAS_INSTANCE: instance, OAS_HOME: home, OAS_AGENT: agentName,
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
      results.warnings.push(`${cap.id} ${event} hook failed (continuing): ${String(e.message || e).slice(0, 200)}`);
      // Structured failure record — compensation/rollback callers must be able
      // to DETECT hook failures, not just print them (warnings are advisory).
      results.failures.push({ capability: cap.id, event, message: String(e.message || e).slice(0, 200) });
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

export function spawnInstance(root, agent, o = {}) {
  const work = o.work || agent.work || "checkout";
  if (!["worktree", "checkout", "attached", "workspace"].includes(work)) throw new Error(`unknown work mode "${work}" (worktree|checkout|attached|workspace)`);
  if (work === "attached" && !o.workDir) throw new Error(`attached mode needs workDir — the owning instance's work tree (its <home>/work)`);
  if (o.task !== undefined && typeof o.task !== "string") throw new Error(`task must be a string (got ${typeof o.task}) — a flag parser handing --task's next flag through shows up here`);
  const runtime = o.runtime || agent.runtime || "pi";
  const model = resolveModelPreference(o.model || agent.model || "", runtime);
  const session = o.tmuxSession || DEFAULT_TMUX_SESSION;
  const launch = o.launch !== false;
  const repoAbs = resolveRepo(root, o.repo || agent.repo);
  if (!repoAbs) throw new Error(`agent "${agent.name}" has no repo configured — pass one`);

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
  mkdirSync(home, { recursive: true });

  // Body: the soul is linked for reference, while instructions are a generated instance-local view.
  // Capability-defined agents carry _soulDir (read-only soul inside the package).
  const soulDir = agent._soulDir || soulOf(agent._dir);
  const composition = composeInstanceAgentsMd(soulDir, repoAbs, agent.name, work, agent.kind);
  const resolvedCfg = composition.resolved;
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
  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    if (existsSync(join(source.path, "SKILL.md"))) offer(basename(source.path), source.path, source.id);
    else for (const e of readdirSync(source.path, { withFileTypes: true })) if (e.isDirectory() && existsSync(join(source.path, e.name, "SKILL.md"))) offer(e.name, join(source.path, e.name), source.id);
  }
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  for (const [name, selected] of [...chosen].sort(([a], [b]) => a.localeCompare(b))) {
    // Pi's recursive skill scanner does not descend through directory symlinks.
    // Copy each selected tree so the exact instance-local set is real and immutable.
    cpSync(realpathSync(selected.src), join(home, ".agents", "skills", name), { recursive: true });
  }
  symlinkSync(join("..", ".agents", "skills"), join(home, ".claude", "skills"));

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
          catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr || e2.message || "").trim() }; }
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
    // Ambient skills coexist: pi discovers user/project/package skills in addition
    // to the explicit OAS-composed instance set (see the ambient-skills decision).
    cmdline = `${shq(bin)} --skill ${shq(join(home, ".agents", "skills"))} --approve --name ${shq(instance)}${model ? ` --model ${shq(model)}` : ""}${hookArgs} ${shq("@TASK.md")}`;
  }
  cmdline = `OAS_INSTANCE=${shq(instance)} PI_AGENT_INSTANCE=${shq(instance)} PI_AGENT_HOME=${shq(home)} ${cmdline}`;

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
        catch (e2) { return { ok: false, status: e2.status, err: String(e2.stderr || e2.message || "").trim() }; }
      };
      try { rmSync(tmpPath, { force: true }); } catch (e2) { incomplete.push(`temp file ${tmpPath}: ${e2.message}`); }
      if (launched) {
        // shTry returns "" on success and undefined on failure — neither is a
        // reliable signal for kill-window, so verify the EFFECT unconditionally.
        shTry(`tmux kill-window -t ${shq(`=${session}:=${instance}`)}`);
        const winProbe = probe(["tmux", "list-windows", "-t", session, "-F", "#{window_name}"]);
        if (!winProbe.ok) incomplete.push(`tmux window ${session}:${instance}: could not verify removal (${winProbe.err || "list-windows failed"})`);
        else if (winProbe.out.split("\n").includes(instance)) incomplete.push(`tmux window ${session}:${instance} still running`);
      }
      try {
        const comp = runLifecycleHooks("retire", {
          home, instance, agentName: agent.name, soulDir, contextDir: repoAbs,
          workspaceDir: workspaceOf(root), rootDir: root, resolved: resolvedCfg,
          priorMeta: hookRes.meta || {},
        });
        // runLifecycleHooks catches hook errors internally — detect them via
        // the structured failures field, not this outer catch.
        for (const f of comp.failures || []) incomplete.push(`retire hook ${f.capability}: ${f.message}`);
      } catch (e2) { incomplete.push(`retire hooks: ${e2.message}`); }
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
        if (!wtProbe.ok) incomplete.push(`git worktree ${wtCanonical}: could not verify removal (${wtProbe.err || "worktree list failed"})`);
        else {
          const registered = wtProbe.out.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice("worktree ".length));
          if (wtCanonical && registered.includes(wtCanonical)) incomplete.push(`git worktree ${wtCanonical}: still registered`);
        }
        if (branch) {
          probe(["git", "-C", repoAbs, "branch", "-D", branch]);
          // rev-parse --verify: exit 0 = ref exists; exit 1 with empty stderr
          // under --quiet = confirmed absent; anything else = could not verify.
          const brProbe = probe(["git", "-C", repoAbs, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
          if (brProbe.ok) incomplete.push(`git branch ${branch}: still exists`);
          else if (brProbe.status !== 1 || brProbe.err) incomplete.push(`git branch ${branch}: could not verify deletion (${brProbe.err || `rev-parse exit ${brProbe.status}`})`);
        }
      }
      try { rmSync(home, { recursive: true, force: true }); } catch (e2) { incomplete.push(`instance home ${home}: ${e2.message}`); }
      if (existsSync(home) && !incomplete.some((m) => m.startsWith("instance home"))) incomplete.push(`instance home ${home}: still present`);
      const rollbackNote = incomplete.length
        ? `rollback INCOMPLETE — clean up manually: ${incomplete.join("; ")}`
        : "spawn rolled back (window killed, hooks compensated, scaffold removed)";
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
        const meta = existsSync(metaPath)
          ? JSON.parse(readFileSync(metaPath, "utf8"))
          : { instance: e.name, home: join(instancesDir, e.name) };
        return { ...meta, running: windows.includes(meta.instance || e.name) };
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

export function retireInstance(root, name, o = {}) {
  const session = o.tmuxSession || DEFAULT_TMUX_SESSION;
  const self = o.self === true; // self-retire: the caller IS the instance — kill the window LAST
  const found = findInstanceHome(root, name);
  if (!found) throw new Error(`no instance named "${name}"`);
  const metaPath = join(found.home, "instance.json");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};

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
  if (!o.keepDir) rmSync(found.home, { recursive: true, force: true });


  const result = { retired: name, agent: found.agent.name, worktreeRemoved: isWorktree, branchDeleted: !!(o.deleteBranch && meta.branch), removedDir: !o.keepDir, harvested, relinked: relinked.length ? relinked : undefined, capabilityMeta: hookResults?.meta, warnings: hookResults?.warnings?.length ? hookResults.warnings : undefined };
  if (self) {
    // The caller is the instance: its process lives in the window we are about to
    // kill. Detach the kill so this function can return and the caller can report
    // before dying. The delay is the caller's window to print its last words.
    shTry(`tmux run-shell -b 'sleep ${o.selfKillDelaySec ?? 8}; tmux kill-window -t ${shq(`=${session}:=${name}`)} 2>/dev/null || true'`);
    result.selfKillScheduled = true;
  }
  return result;
}
