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
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
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
    if (RETIRED_CAPABILITIES[id]) throw new Error(`capability "${id}" is activated in config but ${RETIRED_CAPABILITIES[id]}`);
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
      // Annotate marketplace-sourced installs (their lock source is marketplace:<id>@<version>):
      // they may resolve framework-hoisted resources and are trusted at acquisition.
      const lockFile = join(cfg._level, OAS_LOCK_FILE);
      if (existsSync(lockFile)) {
        try {
          const locks = JSON.parse(readFileSync(lockFile, "utf8")).capabilities || {};
          for (const m of Object.values(out)) {
            if (m._origin === `installed:${cfg._level}` && String(locks[m.capability]?.source || "").startsWith("marketplace:")) m._marketplace = true;
          }
        } catch { /* doctor reports broken locks */ }
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
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      for (const [id, lock] of Object.entries(parsed.capabilities || {})) out[id] = { ...lock, _file: file };
    } catch { /* doctor reports unresolved trust through the package state */ }
  }
  return out;
}
export function writeCapabilityLock(levelDir, id, lock) {
  const file = join(levelDir, OAS_LOCK_FILE);
  let parsed = { lockfileVersion: 1, capabilities: {} };
  if (existsSync(file)) parsed = JSON.parse(readFileSync(file, "utf8"));
  parsed.lockfileVersion = 1; parsed.capabilities ||= {}; parsed.capabilities[id] = lock;
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
export function acquireCapability(levelDir, src, { expectIntegrity } = {}) {
  if (RETIRED_CAPABILITIES[src]) throw new Error(`${RETIRED_CAPABILITIES[src]}`);
  const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(src);
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
    if (isUrl) execFileSync("git", ["clone", "-q", src, dest], { stdio: "inherit" });
    else execFileSync("cp", ["-R", from, dest]);
    if (!existsSync(join(dest, "oas.json"))) throw new Error(`installed artifact has no oas.json: ${dest}`);
    const manifest = JSON.parse(readFileSync(join(dest, "oas.json"), "utf8"));
    if (!manifest.capability) throw new Error("manifest needs a namespaced capability ID");
    // Retirement applies to the acquired manifest's ID too: a local path or
    // git URL can carry a package whose oas.json declares a retired
    // capability that can never be activated (catch below removes dest).
    if (RETIRED_CAPABILITIES[manifest.capability]) throw new Error(`this package declares capability "${manifest.capability}" — ${RETIRED_CAPABILITIES[manifest.capability]}`);
    const integrity = capabilityIntegrity(dest);
    if (expectIntegrity && integrity !== expectIntegrity) {
      throw new Error(`restored artifact integrity ${integrity} does not match locked ${expectIntegrity}; the source has drifted — reacquire explicitly`);
    }
    const commit = isUrl ? execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() : undefined;
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
  for (const level of levels.reverse()) {
    const file = join(level, OAS_LOCK_FILE);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, lock] of Object.entries(parsed.capabilities || {})) {
      // Retirement wins over presence: report the stale artifact, never "ok".
      if (RETIRED_CAPABILITIES[id]) { report.push({ id, level, status: "retired", reason: RETIRED_CAPABILITIES[id] }); continue; }
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
        report.push({ id, level, status: "failed", reason: e.message });
      }
    }
  }
  return report;
}
export function capabilityTrust(manifest, startDir) {
  if (!manifest) return { trusted: false, reason: "manifest missing" };
  const lock = readCapabilityLocks(startDir)[manifest.capability];
  if (String(manifest._origin).startsWith("owned:")) return { trusted: true, configOwned: true };
  if (!lock) return { trusted: false, reason: `not locked in ${OAS_LOCK_FILE}` };
  const integrity = capabilityIntegrity(manifest._dir);
  if (lock.integrity !== integrity) return { trusted: false, reason: `integrity differs from ${lock._file}`, integrity, lock };
  const executable = Object.keys(manifest.commands || {}).length > 0 || Object.keys(manifest.hooks || {}).length > 0;
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

/** Unmet external requirements of a capability. */
export function capabilityMissingRequires(name, startDir) {
  const m = capabilityManifest(name, startDir);
  return (m?.requires || []).filter((r) => r.command && !which(r.command));
}

/** Resolve a manifest-relative path; only marketplace-sourced packages may use framework-hoisted resources. */
function manifestPath(manifest, rel) {
  const local = join(manifest._dir, rel);
  if (existsSync(local)) {
    const root = realpathSync(manifest._dir); const target = realpathSync(local); const fromRoot = relative(root, target);
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
function assertCapabilityTreeContained(manifest, tree) {
  // Marketplace-sourced installs may reference framework-hoisted trees (outside the copy).
  if (manifest._marketplace && !tree.startsWith(realpathSync(manifest._dir))) return;
  const artifact = realpathSync(manifest._dir);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        const fromArtifact = relative(artifact, target);
        if (fromArtifact === ".." || fromArtifact.startsWith(`..${sep}`) || isAbsolute(fromArtifact)) {
          throw new Error(`capability ${manifest.capability} skill path escapes its integrity boundary: ${relative(manifest._dir, path)}`);
        }
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
  const results = { meta: {}, briefs: [], warnings: [], order: [], launch: {} };
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
export function findCapabilityAgent(contextDir, root, name) {
  for (const id of declaredCapabilityIds(contextDir)) {
    const manifest = capabilityManifest(id, contextDir);
    for (const rel of manifest?.agents || []) {
      const soulDir = manifestPath(manifest, rel);
      if (!soulDir || !existsSync(join(soulDir, "soul.yaml"))) continue;
      const soul = parseYamlFlat(readFileSync(join(soulDir, "soul.yaml"), "utf8"));
      if ((soul.name || basename(soulDir)) !== name) continue;
      return {
        ...soul, name,
        kind: "capability", capability: id,
        _dir: join(localAgentsDirOf(root), name), // instances home locally (scope's local-agents/)
        _soulDir: soulDir,                        // canonical soul stays in the package
      };
    }
  }
  return undefined;
}
/** All capability-defined agents declared in a context (for status/errors). */
export function listCapabilityAgents(contextDir) {
  const out = [];
  for (const id of declaredCapabilityIds(contextDir)) {
    const manifest = capabilityManifest(id, contextDir);
    for (const rel of manifest?.agents || []) {
      const soulDir = manifestPath(manifest, rel);
      if (!soulDir || !existsSync(join(soulDir, "soul.yaml"))) continue;
      const soul = parseYamlFlat(readFileSync(join(soulDir, "soul.yaml"), "utf8"));
      out.push({ name: soul.name || basename(soulDir), capability: id, description: soul.description, soulDir });
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
 * Unknown runtimes or probe failures: first entry wins (pi errors loudly at launch). */
export function resolveModelPreference(model, runtime = "pi") {
  const prefs = String(model || "").split(",").map((s) => s.trim()).filter(Boolean);
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
  const sources = [{ id: "kernel", path: join(PACKAGED_SKILLS_DIR, "oas") }, { id: "kernel", path: join(PACKAGED_SKILLS_DIR, "oas-config") }];
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
  if (work === "worktree") {
    branch = o.branch || `agents/${instance}`;
    try {
      execFileSync("git", ["-C", repoAbs, "worktree", "add", join(home, "work"), "-b", branch],
        { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      rmSync(home, { recursive: true, force: true });
      throw new Error(`git worktree add failed: ${e.stderr?.toString().trim() || e.message}`);
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
    cmdline = `${shq(bin)}${model ? ` --model ${shq(model)}` : ""}${hookArgs} "$(cat TASK.md)"`;
  } else {
    // Ambient skills coexist: pi discovers user/project/package skills in addition
    // to the explicit OAS-composed instance set (see the ambient-skills decision).
    cmdline = `${shq(bin)} --skill ${shq(join(home, ".agents", "skills"))} --approve --name ${shq(instance)}${model ? ` --model ${shq(model)}` : ""}${hookArgs} ${shq("@TASK.md")}`;
  }
  cmdline = `OAS_INSTANCE=${shq(instance)} PI_AGENT_INSTANCE=${shq(instance)} PI_AGENT_HOME=${shq(home)} ${cmdline}`;

  // Forward-only lineage: EXPLICIT only. o.parent (CLI --parent) names the parent;
  // for attached mode, fall back to the OWNER of the shared work tree
  // (workDir = <home>/work) so attached service agents nest under the instance
  // they serve. Ambient env (OAS_INSTANCE/PI_AGENT_INSTANCE) is deliberately NOT
  // consulted: any shell opened inside an agent's tmux window inherits those vars,
  // and env inheritance is not evidence of intent — human spawns from such shells
  // were misattributed as instance-origin. Manual spawns land top-level unless a
  // parent is explicitly given (operator directive).
  let parentInstance = typeof o.parent === "string" && o.parent.trim() ? o.parent.trim() : undefined;
  if (!parentInstance && work === "attached" && o.workDir) {
    // workDir is the owner's <home>/work; the owner's home dir name IS its instance name.
    const wd = resolve(o.workDir);
    const owner = basename(wd) === "work" ? basename(dirname(wd)) : undefined;
    if (owner && owner !== instance) parentInstance = owner;
  }
  const meta = {
    agent: agent.name, kind: agent.kind || "persistent", instance, home,
    repo: repoAbs, work, branch, runtime, model: model || undefined,
    team: resolvedCfg.team || undefined,
    parentInstance: parentInstance && parentInstance !== instance ? parentInstance : undefined,
    spawnOrigin: parentInstance && parentInstance !== instance ? "instance" : "operator",
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
  if (typeof name !== "string" || !INSTANCE_NAME_RE.test(name)) return undefined;
  const contained = (agentDir) => {
    const home = join(agentDir, "instances", name);
    if (!existsSync(home)) return undefined;
    try {
      const real = realpathSync(home);
      if (dirname(real) !== realpathSync(join(agentDir, "instances")) || basename(real) !== name) return undefined;
    } catch { return undefined; }
    return home;
  };
  for (const a of listAgents(root)) {
    const home = contained(a._dir);
    if (home) return { agent: a, home };
  }
  for (const dir of localAgentBases(root)) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const home = contained(join(dir, e.name));
      if (home) return { agent: { name: e.name, kind: "capability", _dir: join(dir, e.name) }, home };
    }
  }
  return undefined;
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
  if (isWorktree && meta.repo) {
    shTry(`git -C ${shq(meta.repo)} worktree remove --force ${shq(workPath)}`);
    shTry(`git -C ${shq(meta.repo)} worktree prune`);
    if (o.deleteBranch && meta.branch) shTry(`git -C ${shq(meta.repo)} branch -D ${shq(meta.branch)}`);
  }
  if (!o.keepDir) rmSync(found.home, { recursive: true, force: true });
  const result = { retired: name, agent: found.agent.name, worktreeRemoved: isWorktree, branchDeleted: !!(o.deleteBranch && meta.branch), removedDir: !o.keepDir, harvested, capabilityMeta: hookResults?.meta, warnings: hookResults?.warnings?.length ? hookResults.warnings : undefined };
  if (self) {
    // The caller is the instance: its process lives in the window we are about to
    // kill. Detach the kill so this function can return and the caller can report
    // before dying. The delay is the caller's window to print its last words.
    shTry(`tmux run-shell -b 'sleep ${o.selfKillDelaySec ?? 8}; tmux kill-window -t ${shq(`=${session}:=${name}`)} 2>/dev/null || true'`);
    result.selfKillScheduled = true;
  }
  return result;
}
