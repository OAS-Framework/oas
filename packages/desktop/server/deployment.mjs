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
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RESERVED = new Set(["bin", "local-agents", "tmp-agents"]);
export const LOCAL_AGENTS_DIR = "local-agents";
const LEGACY_LOCAL_DIRS = ["tmp-agents"];
export const DEFAULT_TMUX_SESSION = process.env.PI_AGENTS_TMUX_SESSION || "pi-agents";
const CAPABILITIES_DIRNAME = join(".agents", "capabilities");
const INSTALLED_SUBDIR = "installed";
const OWNED_SUBDIR = "owned";

// ---- tiny YAML subset (same shapes the kernel accepts) --------------------

/** Flat `key: value` YAML (soul.yaml, skill frontmatter). */
export function parseYamlFlat(text) {
  const o = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*(#.*)?$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "");
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
      out[part.slice(0, i).trim().replace(/^["']|["']$/g, "")] = yamlScalar(part.slice(i + 1));
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

/** Agents roots of a team scope: <scope>/agents plus every child repo's agents/. */
export function teamAgentRoots(teamScope) {
  const roots = [];
  const push = (p) => { try { if (existsSync(p) && lstatSync(p).isDirectory()) roots.push(resolve(p)); } catch { /* skip */ } };
  push(join(teamScope, "agents"));
  let entries = [];
  try { entries = readdirSync(teamScope, { withFileTypes: true }); } catch { return roots; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "agents" || e.name === "node_modules") continue;
    push(join(teamScope, e.name, "agents"));
  }
  return roots;
}

/** Closest agents/ dir walking up from cwd — READ-ONLY discovery (never
 * creates). Returns undefined when the context has no deployment. */
export function findAgentsRoot(cwd) {
  if (process.env.PI_AGENTS_ROOT) return resolve(process.env.PI_AGENTS_ROOT);
  let d = resolve(cwd);
  while (true) {
    try {
      if (basename(d) === "agents" && lstatSync(d).isDirectory()) return d;
      const candidate = join(d, "agents");
      if (existsSync(candidate) && lstatSync(candidate).isDirectory()) return candidate;
    } catch { /* unreadable dir — keep walking */ }
    const parent = dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

// ---- souls (local agents) ---------------------------------------------------

function readSoul(agentDir) {
  const p = join(agentDir, "soul", "soul.yaml");
  try {
    if (!existsSync(p)) return undefined;
    const soul = parseYamlFlat(readFileSync(p, "utf8"));
    soul._dir = agentDir;
    soul.name = soul.name || basename(agentDir);
    return soul;
  } catch { return undefined; }
}

/** Souls under an agents root: persistent at the top level, tmp under
 * local-agents/ (and the legacy tmp-agents/). */
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
  scan(join(root, LOCAL_AGENTS_DIR), "tmp");
  for (const legacy of LEGACY_LOCAL_DIRS) scan(join(root, legacy), "tmp");
  return agents;
}

export function findAgent(root, name) {
  for (const dir of [join(root, name), join(root, LOCAL_AGENTS_DIR, name), ...LEGACY_LOCAL_DIRS.map((l) => join(root, l, name))]) {
    const soul = readSoul(dir);
    if (soul) return soul;
  }
  return undefined;
}

// ---- capability manifests (read-only subset) -------------------------------

function loadManifestAt(idir) {
  const mf = join(idir, "oas.json");
  try {
    if (!existsSync(mf)) return undefined;
    const m = JSON.parse(readFileSync(mf, "utf8"));
    if (!m.capability) return undefined;
    return { ...m, _dir: idir };
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
  const out = {};
  const loadDir = (dir) => {
    let entries = [];
    try { entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []; } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = loadManifestAt(join(dir, e.name));
      if (m) out[m.capability] = m; // later (inner/owned) sources overwrite
    }
  };
  for (const cfg of [...configChain(startDir)].reverse()) {
    loadDir(join(cfg._level, CAPABILITIES_DIRNAME, INSTALLED_SUBDIR));
    loadDir(join(cfg._level, CAPABILITIES_DIRNAME, OWNED_SUBDIR));
    // `from: path:` package sources
    const caps = cfg.capabilities || {};
    for (const entry of [...Object.values(caps.layers || {}), ...Object.values(caps.additive || {})]) {
      const from = String(entry?.from || "");
      if (!from.startsWith("path:")) continue;
      const p = from.slice(5);
      const m = loadManifestAt(isAbsolute(p) ? p : join(cfg._level, p));
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

/** All capability-declared agents (souls shipped by active packages). */
export function listCapabilityAgents(contextDir) {
  const out = [];
  const manifests = capabilityManifests(contextDir);
  const declared = new Set();
  for (const cfg of configChain(contextDir)) for (const id of configCapabilityIds(cfg)) declared.add(id);
  for (const id of declared) {
    const manifest = manifests[id];
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
      _dir: join(root, LOCAL_AGENTS_DIR, name),
      _soulDir: c.soulDir,
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
          // and arrays/scalars are valid JSON but not instance metadata —
          // merge OVER the fallback so instance/home are always present.
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            meta = { ...fallback, ...parsed };
            if (typeof meta.instance !== "string" || !meta.instance) meta.instance = fallback.instance;
            if (typeof meta.home !== "string" || !meta.home) meta.home = fallback.home;
          }
        }
      } catch { /* broken metadata — show the bare instance */ }
      return { ...meta, running: windows.includes(meta.instance) };
    });
  };
  const out = listAgents(root).map((a) => {
    const { _dir, ...soul } = a;
    return { ...soul, dir: _dir, instances: readInstancesOf(a._dir) };
  });
  // Capability-defined agents home under local-agents/<name>/ WITHOUT a local
  // soul (it lives read-only in the package) — surface their instances too.
  const seen = new Set(out.map((a) => a.name));
  for (const base of [LOCAL_AGENTS_DIR, ...LEGACY_LOCAL_DIRS]) {
    const dir = join(root, base);
    let entries = [];
    try { entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []; } catch { continue; }
    for (const e of entries) {
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
