// OAS desktop — app-owned READ-ONLY deployment reader.
//
// The packaged desktop app must not import the framework checkout's
// kernel module, accept a framework-root environment override, or
// bundle a hidden OAS kernel (desktop-dist contract, packaged boundary).
// This module is the replacement: it reads an OAS deployment from disk —
// enough for roster/hierarchy, brain/markdown/task/state/git reads and
// attaching to existing tmux sessions — and NOTHING more. Every lifecycle
// mutation (spawn, harvest) goes through the installed `oas` CLI's JSON API.
//
// Design rules (deliberate differences from the kernel):
//   * READ-ONLY: no ensureRoot side effects, no scaffolding, no writes.
//   * FAULT-TOLERANT: a malformed oas-config.yaml, soul.yaml, manifest, or
//     lock file must degrade to "not visible", never crash the server —
//     the app observes deployments it does not own.
//   * NO KERNEL AUTHORITY: this reader never decides what a spawn/harvest
//     would do; API-version acceptance and mutations belong to the CLI.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export const RESERVED = new Set(["bin", "local-agents", "tmp-agents"]);
/** Local (uncommitted) souls dir: <scope>/local-agents, a SIBLING of agents/
 * (kernel commit 030ad49) — full souls, gitignored by contract. Legacy nested
 * <root>/local-agents and <root>/tmp-agents are still read. */
export const LOCAL_AGENTS_DIR = "local-agents";
const LEGACY_LOCAL_DIRS = ["local-agents", "tmp-agents"]; // nested-in-root legacy locations
/** The scope-level local agents dir for an agents root (the root's sibling). */
export const localAgentsDirOf = (root) => join(dirname(root), LOCAL_AGENTS_DIR);
/** All local-agent base dirs readable for a root: scope sibling (canonical)
 * plus legacy nested locations. */
function localAgentBases(root) {
  return [localAgentsDirOf(root), ...LEGACY_LOCAL_DIRS.map((l) => join(root, l))];
}
export const DEFAULT_TMUX_SESSION = process.env.PI_AGENTS_TMUX_SESSION || "pi-agents";
const CAPABILITIES_DIRNAME = join(".agents", "capabilities");
const INSTALLED_SUBDIR = "installed";
const OWNED_SUBDIR = "owned";

// ---- tiny YAML subset (same shapes the kernel accepts) --------------------

/** `__proto__` is never data in a plain-object mapping: assigning it REWRITES
 * the parsed object's prototype, so the entry vanishes from `Object.keys` while
 * still answering property reads. These readers duplicate the kernel's, so they
 * duplicate its refusal — the documented "refused by every YAML reader" has to
 * be true of the app-owned reader too. The desktop's own contract then applies:
 * every call site here catches, so the document degrades to "not visible"
 * instead of crashing the server. */
function yamlKey(key) {
  if (key === "__proto__") {
    const e = new Error(`unsupported mapping key "__proto__" — it rewrites the parsed object's prototype instead of becoming data`);
    e.code = "unsafe-config-key";
    throw e;
  }
  return key;
}

/** Flat `key: value` YAML (soul.yaml, skill frontmatter). */
export function parseYamlFlat(text) {
  const o = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*(#.*)?$/);
    if (m) o[yamlKey(m[1])] = m[2].replace(/^["']|["']$/g, "");
  }
  return o;
}

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
      out[yamlKey(part.slice(0, i).trim().replace(/^["']|["']$/g, ""))] = yamlScalar(part.slice(i + 1));
    }
    return out;
  }
  return val.replace(/^["']|["']$/g, "");
}

/** Nested-map YAML subset (oas-config.yaml). */
export function parseYamlNested(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of String(text).split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = raw.match(/^(\s*)((?:["'][^"']+["'])|(?:[^:#][^:]*?)):\s*(.*?)\s*$/);
    if (!m) continue;
    const [, ws, rawKey, rawVal] = m;
    const key = yamlKey(rawKey.trim().replace(/^["']|["']$/g, ""));
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

/** `--- yaml --- body` frontmatter split (skills, knowledge concepts). */
export function parseFrontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  return { meta: parseYamlFlat(m[1]), body: m[2].trim() + "\n" };
}

// ---- config chain + team scope (read-only, tolerant) -----------------------

/** All oas-config.yaml levels from startDir upward, closest first. Unlike the
 * kernel, an unreadable/invalid level is SKIPPED (observation must survive
 * foreign deployments with configs a newer/older kernel wrote). */
export function configChain(startDir) {
  const chain = [];
  let d = resolve(startDir);
  while (true) {
    const file = join(d, "oas-config.yaml");
    if (existsSync(file)) {
      try {
        const cfg = parseYamlNested(readFileSync(file, "utf8"));
        cfg._level = d; cfg._file = file;
        chain.push(cfg);
      } catch { /* unreadable level — skip */ }
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return chain;
}

/** Team resolution for a context: closest `team:` declaration wins; the
 * declaring scope is the team boundary. Returns { team|null, chain }. */
export function resolveDeployment(contextDir) {
  const chain = configChain(contextDir);
  const teamCfg = chain.find((c) => c.team && typeof c.team === "object" && c.team.name);
  return {
    team: teamCfg ? { ...teamCfg.team, scope: teamCfg._level } : null,
    chain,
  };
}

/** Agents roots of a team scope: <scope>/agents plus every child repo's
 * agents/. A member counts when it has agents/ OR only local-agents/ (the
 * canonical root is then the — possibly absent — sibling agents/). */
export function teamAgentRoots(teamScope) {
  const roots = [];
  const push = (p) => {
    try {
      if ((existsSync(p) && lstatSync(p).isDirectory()) ||
          (existsSync(localAgentsDirOf(p)) && lstatSync(localAgentsDirOf(p)).isDirectory())) roots.push(resolve(p));
    } catch { /* skip */ }
  };
  push(join(teamScope, "agents"));
  let entries = [];
  try { entries = readdirSync(teamScope, { withFileTypes: true }); } catch { return roots; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "agents" || e.name === LOCAL_AGENTS_DIR || e.name === "node_modules") continue;
    push(join(teamScope, e.name, "agents"));
  }
  return roots;
}

/** Closest agents/ dir walking up from cwd — READ-ONLY discovery (never
 * creates). A scope with only local-agents/ (all-local deployments) resolves
 * to its possibly-absent sibling agents/ as the canonical root, mirroring the
 * kernel. Returns undefined when the context has no deployment. */
export function findAgentsRoot(cwd) {
  if (process.env.PI_AGENTS_ROOT) return resolve(process.env.PI_AGENTS_ROOT);
  let d = resolve(cwd);
  while (true) {
    try {
      if (basename(d) === "agents" && lstatSync(d).isDirectory()) return d;
      if (basename(d) === LOCAL_AGENTS_DIR && lstatSync(d).isDirectory() && basename(dirname(d)) !== "agents") {
        return join(dirname(d), "agents"); // sibling layout: canonical root beside local-agents (may not exist)
      }
      const candidate = join(d, "agents");
      if (existsSync(candidate) && lstatSync(candidate).isDirectory()) return candidate;
      // A scope with only local souls is fully operable: canonical root is
      // the (possibly absent) sibling agents/ dir.
      if (existsSync(join(d, LOCAL_AGENTS_DIR)) && lstatSync(join(d, LOCAL_AGENTS_DIR)).isDirectory()) return candidate;
    } catch { /* unreadable dir — keep walking */ }
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

// ---- souls (local agents) ---------------------------------------------------

/** The `_`-prefixed namespace belongs to the READER, not to the document: `_dir`,
 * `_soulDir`, `_origin`, `_level` and `_packageDir` are this module's own
 * statements about where something was found, and consumers act on them. The
 * reachable case is `_soulDir`: the brain view reads
 * `def._soulDir || join(def._dir, "soul")`, so a local soul.yaml that could
 * declare `_soulDir` would redirect the skills/knowledge read at any directory
 * on the machine. Strip the whole namespace before annotating rather than
 * relying on each writer to assign after the spread — the same invariant the
 * kernel enforces in its own manifest and soul readers.
 *
 * `__proto__` starts with `_`, so a `__proto__` key is dropped here rather than
 * re-assigned through the inherited setter. */
function stripInternalAnnotations(parsed) {
  const out = {};
  for (const key of Object.keys(parsed)) if (!key.startsWith("_")) out[key] = parsed[key];
  return out;
}

function readSoul(agentDir) {
  const p = join(agentDir, "soul", "soul.yaml");
  try {
    if (!existsSync(p)) return undefined;
    const soul = stripInternalAnnotations(parseYamlFlat(readFileSync(p, "utf8")));
    soul._dir = agentDir;
    soul.name = soul.name || basename(agentDir);
    if (soul.kind === "tmp") soul.kind = "local"; // legacy kind — one shape now: full local souls
    return soul;
  } catch { return undefined; }
}

/** Souls under an agents root: persistent at the top level, LOCAL souls in
 * the scope-level local-agents/ sibling (plus legacy nested locations).
 * Local souls are FULL souls — memory, skills, instances — that are
 * gitignored by contract; the roster treats them as first-class. */
export function listAgents(root) {
  const agents = [];
  const scan = (base, kind) => {
    let entries = [];
    try { entries = existsSync(base) ? readdirSync(base, { withFileTypes: true }) : []; } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || (kind === "persistent" && RESERVED.has(e.name))) continue;
      const soul = readSoul(join(base, e.name));
      if (soul) { soul.kind = soul.kind || kind; agents.push(soul); }
    }
  };
  scan(root, "persistent");
  const seen = new Set();
  for (const base of localAgentBases(root)) {
    if (seen.has(base)) continue; // sibling and nested can collide on odd layouts
    seen.add(base);
    scan(base, "local");
  }
  return agents;
}

export function findAgent(root, name) {
  for (const dir of [join(root, name), ...localAgentBases(root).map((b) => join(b, name))]) {
    const soul = readSoul(dir);
    if (soul) return soul;
  }
  return undefined;
}

// ---- capability manifests (read-only subset) -------------------------------

function loadManifestAt(idir, origin, level) {
  const mf = join(idir, "oas.json");
  try {
    if (!existsSync(mf)) return undefined;
    const raw = JSON.parse(readFileSync(mf, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const m = stripInternalAnnotations(raw);
    if (!m.capability) return undefined;
    return { ...m, _dir: idir, _origin: origin, _level: level };
  } catch { return undefined; }
}

function configCapabilityIds(cfg) {
  const ids = [];
  const caps = cfg?.capabilities || {};
  for (const entry of Object.values(caps.layers || {})) {
    if (entry && typeof entry === "object" && entry.capability) ids.push(entry.capability);
  }
  for (const id of Object.keys(caps.additive || {})) ids.push(id);
  return ids;
}

/** Manifests visible from a context: each chain level's installed/ then
 * owned/ capability stores, inner scopes and owned/ taking precedence.
 * Hoisted framework-repo resources are NOT resolved — the packaged app has
 * no framework checkout; a manifest path that does not exist inside the
 * package simply does not resolve (fail-quiet, read-only degradation). */
function capabilityManifests(startDir) {
  // Capability-id keyed and indexed with ids straight out of oas-config.yaml
  // (`manifests[id]`, `capabilitySkillDirs(name, …)`): a plain map would answer
  // Object.prototype for `constructor`/`toString`.
  const out = Object.create(null);
  const loadDir = (dir, origin, level) => {
    let entries = [];
    try { entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []; } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = loadManifestAt(join(dir, e.name), origin, level);
      if (m) out[m.capability] = m; // later (inner/owned) sources overwrite
    }
  };
  for (const cfg of [...configChain(startDir)].reverse()) {
    loadDir(join(cfg._level, CAPABILITIES_DIRNAME, INSTALLED_SUBDIR), "installed", cfg._level);
    loadDir(join(cfg._level, CAPABILITIES_DIRNAME, OWNED_SUBDIR), "owned", cfg._level);
    // `from: path:` package sources
    const caps = cfg.capabilities || {};
    for (const entry of [...Object.values(caps.layers || {}), ...Object.values(caps.additive || {})]) {
      const from = String(entry?.from || "");
      if (!from.startsWith("path:")) continue;
      const p = from.slice(5);
      const m = loadManifestAt(isAbsolute(p) ? p : join(cfg._level, p), "path", cfg._level);
      if (m) out[m.capability] = m;
    }
  }
  return out;
}

/** Package-relative path, contained inside the package dir (a manifest must
 * not read outside its own tree — same escape guard as the kernel). */
function manifestPath(manifest, rel) {
  const local = join(manifest._dir, rel);
  try {
    if (!existsSync(local)) return undefined;
    const root = realpathSync(manifest._dir);
    const target = realpathSync(local);
    const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
    return local;
  } catch { return undefined; }
}

/** True when `file`'s REALPATH stays inside the package root. The
 * manifest-entry check above is not enough: a nested symlink (e.g.
 * agents/helper/soul.yaml → /outside/soul.yaml) passes the directory check
 * while the file itself escapes — every file read from a package must pass
 * through here first. */
function containedFile(packageDir, file) {
  try {
    const root = realpathSync(packageDir);
    const target = realpathSync(file);
    const fromRoot = relative(root, target);
    return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
  } catch { return false; }
}

/** Read + parse a flat-YAML file only if it is really inside the package. */
function readContainedYaml(packageDir, file) {
  if (!existsSync(file) || !containedFile(packageDir, file)) return undefined;
  try { return parseYamlFlat(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** Kernel-compatible standalone capability digest (excludes VCS + lock). */
function capabilityIntegrity(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === "oas-lock.json") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { hash.update(relative(dir, p)); hash.update("\0file\0"); hash.update(readFileSync(p)); hash.update("\0"); }
      else if (e.isSymbolicLink()) { hash.update(relative(dir, p)); hash.update("\0symlink\0"); hash.update(readlinkSync(p)); hash.update("\0"); }
    }
  };
  try { walk(dir); return `sha256-${hash.digest("hex")}`; } catch { return undefined; }
}

/** Strict, read-only lock validation. Any invalidity discards the ENTIRE file;
 * the Desktop degrades to invisible but never partially salvages trust data. */
function validatedLockCapabilities(file) {
  let p;
  try { p = JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
  const map = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!map(p)) return undefined;
  if (p.lockfileVersion !== undefined && (typeof p.lockfileVersion !== "number" || ![1, 2].includes(p.lockfileVersion))) return undefined;
  const capabilities = p.capabilities === undefined ? {} : p.capabilities;
  if (!map(capabilities)) return undefined;
  for (const [id, e] of Object.entries(capabilities)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !map(e)) return undefined;
    if (typeof e.source !== "string" || !e.source || typeof e.version !== "string" || !e.version || typeof e.integrity !== "string" || !/^sha256-[0-9a-f]{64}$/.test(e.integrity)) return undefined;
    if (e.commit !== undefined && typeof e.commit !== "string") return undefined;
    if (e.trustedExecutables !== undefined && typeof e.trustedExecutables !== "boolean") return undefined;
  }
  if ((p.lockfileVersion ?? 1) === 2) {
    if (!map(p.packages)) return undefined;
    const allowed = new Set(["source", "version", "commit", "integrity", "depsIntegrity", "capabilities", "dependencies", "trustedCapabilities"]);
    for (const [id, e] of Object.entries(p.packages)) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || !map(e) || Object.keys(e).some((k) => !allowed.has(k))) return undefined;
      if (["source", "version", "commit", "integrity"].some((k) => typeof e[k] !== "string" || !e[k])) return undefined;
      if (!/^sha256-[0-9a-f]{64}$/.test(e.integrity) || (e.depsIntegrity !== undefined && (typeof e.depsIntegrity !== "string" || !/^sha256-[0-9a-f]{64}$/.test(e.depsIntegrity)))) return undefined;
      for (const k of ["capabilities", "dependencies", "trustedCapabilities"]) if (!Array.isArray(e[k]) || e[k].some((x) => typeof x !== "string")) return undefined;
      if (e.trustedCapabilities.some((x) => !e.capabilities.includes(x)) || e.dependencies.some((x) => !Object.hasOwn(p.packages, x))) return undefined;
      if (e.source.startsWith("path:") ? e.commit !== "local" : !/^[0-9a-f]{40}$/.test(e.commit)) return undefined;
    }
    const visiting = new Set(), done = new Set();
    const visit = (id) => {
      if (visiting.has(id)) return false;
      if (done.has(id)) return true;
      visiting.add(id);
      for (const d of p.packages[id].dependencies) if (!visit(d)) return false;
      visiting.delete(id); done.add(id); return true;
    };
    for (const id of Object.keys(p.packages)) if (!visit(id)) return undefined;
  }
  return capabilities;
}

/** Read-only, fail-quiet strict lock merge (closest scope wins). */
function capabilityLocks(startDir) {
  // Null-prototype: `agentProviderTrusted` compares an artifact digest against
  // `locks[capability].integrity`, and on a plain map an id like `constructor`
  // would hand back Object — whose `.integrity` is undefined, which matches the
  // undefined a failed digest returns. Trust must never be answered by the
  // prototype.
  const out = Object.create(null);
  for (const cfg of [...configChain(startDir)].reverse()) {
    const capabilities = validatedLockCapabilities(join(cfg._level, "oas-lock.json"));
    if (!capabilities) continue;
    for (const [id, lock] of Object.entries(capabilities)) out[id] = lock;
  }
  return out;
}

/** Owned artifacts are config-owned; installed/path providers must match lock. */
function agentProviderTrusted(manifest, startDir) {
  if (manifest?._origin === "owned") return true;
  const lock = capabilityLocks(startDir)[manifest?.capability];
  if (!lock) return false;
  // An unreadable tree digests to undefined; it must not compare equal to a
  // missing locked integrity.
  const integrity = capabilityIntegrity(manifest._dir);
  return !!integrity && integrity === lock.integrity;
}

/** All capability-declared agents (souls shipped by active packages). */
export function listCapabilityAgents(contextDir) {
  const out = [];
  const manifests = capabilityManifests(contextDir);
  const declared = new Set();
  for (const cfg of configChain(contextDir)) for (const id of configCapabilityIds(cfg)) declared.add(id);
  for (const id of declared) {
    const manifest = manifests[id];
    // Desktop is read-only/fault-tolerant: invalid providers are not visible.
    if (manifest?.agents?.length && !agentProviderTrusted(manifest, contextDir)) continue;
    for (const rel of manifest?.agents || []) {
      const soulDir = manifestPath(manifest, rel);
      if (!soulDir) continue;
      const soul = readContainedYaml(manifest._dir, join(soulDir, "soul.yaml"));
      if (!soul) continue; // missing, escaping symlink, or unreadable — skip
      out.push({ name: soul.name || basename(soulDir), capability: id, description: soul.description, soulDir, _packageDir: manifest._dir });
    }
  }
  return out;
}

/** Resolve one capability-defined agent by name (roster/brain reads). The
 * canonical soul stays read-only in the package; instances home under the
 * root's local-agents/ (mirrors the kernel's resolution for display only —
 * spawning is the CLI's job). */
export function findCapabilityAgent(contextDir, root, name) {
  for (const c of listCapabilityAgents(contextDir)) {
    if (c.name !== name) continue;
    const soul = readContainedYaml(c._packageDir, join(c.soulDir, "soul.yaml")) || {};
    return {
      ...soul, name,
      kind: "capability", capability: c.capability,
      _dir: join(localAgentsDirOf(root), name), // instances home locally (scope's local-agents/)
      _soulDir: c.soulDir,
      _packageDir: c._packageDir,               // owning package — consumers apply per-file containment
    };
  }
  return undefined;
}

/** Skill tree paths a capability ships (brain view's package skills).
 * Every returned dir is realpath-contained; consumers that WALK these trees
 * must still skip escaping symlinks per entry — use containsPackageFile. */
export function capabilitySkillDirs(name, startDir) {
  const m = capabilityManifests(startDir)[name];
  if (!Array.isArray(m?.skills)) return [];
  return m.skills.map((s) => manifestPath(m, s)).filter(Boolean).map((dir) => ({ dir, packageDir: m._dir }));
}

/** Public containment probe for consumers reading files under a capability
 * skill tree (e.g. the brain view's SKILL.md reads): true only when the
 * file's realpath stays inside the owning package. */
export function containsPackageFile(packageDir, file) {
  return containedFile(packageDir, file);
}

// ---- instances --------------------------------------------------------------

function tmuxWindows(session) {
  try {
    return execFileSync("tmux", ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).split("\n").filter(Boolean);
  } catch { return []; }
}

/** Souls with their instances (roster collection seam — read-only walk of
 * instances/ dirs plus tmux window liveness). */
export function listInstances(root, tmuxSession = DEFAULT_TMUX_SESSION) {
  const windows = tmuxWindows(tmuxSession);
  const readInstancesOf = (agentDir) => {
    const instancesDir = join(agentDir, "instances");
    let entries = [];
    try { entries = existsSync(instancesDir) ? readdirSync(instancesDir, { withFileTypes: true }) : []; } catch { return []; }
    return entries.filter((e) => e.isDirectory()).map((e) => {
      const metaPath = join(instancesDir, e.name, "instance.json");
      const fallback = { instance: e.name, home: join(instancesDir, e.name) };
      let meta = fallback;
      try {
        if (existsSync(metaPath)) {
          const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
          // Semantic validation, not just parseability: JSON.parse("null")
          // and arrays/scalars are valid JSON but not instance metadata.
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = { ...fallback, ...parsed };
        }
      } catch { /* broken metadata — show the bare instance */ }
      // SECURITY (review 53a20c7 blocker): instance.json is WORKSPACE DATA —
      // a crafted file could point `home` at any directory and steer
      // privileged consumers (the harvest endpoint runs the CLI with
      // cwd=home). identity and home are DIRECTORY-DERIVED, always —
      // metadata may add fields but never relocate the instance.
      meta.instance = fallback.instance;
      meta.home = fallback.home;
      return { ...meta, running: windows.includes(meta.instance) };
    });
  };
  const out = listAgents(root).map((a) => {
    const { _dir, ...soul } = a;
    return { ...soul, dir: _dir, instances: readInstancesOf(a._dir) };
  });
  // Capability-defined and local agents can home under a local-agents base
  // WITHOUT a local soul dir visible to listAgents (capability souls live
  // read-only in their package) — surface their instances too.
  const seen = new Set(out.map((a) => a.name));
  const seenBases = new Set();
  for (const dir of localAgentBases(root)) {
    if (seenBases.has(dir)) continue;
    seenBases.add(dir);
    let entries = [];
    try { entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []; } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const instances = readInstancesOf(join(dir, e.name));
      if (!instances.length) continue;
      const cap = instances.find((i) => i.capability)?.capability;
      out.push({ name: e.name, kind: cap ? "capability" : "local", capability: cap, description: cap ? `capability agent (${cap})` : "local agent", dir: join(dir, e.name), instances });
      seen.add(e.name);
    }
  }
  return out;
}
