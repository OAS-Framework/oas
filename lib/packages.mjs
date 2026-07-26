/**
 * OAS distribution packages — phase-1 thin interface (workstream 2).
 *
 * Implements the config-side contracts of the "Distribution packages, config
 * profiles, and consented host requirements" Decision: package manifest
 * reading/validation, lock v2 READING, config profile selection/validation/
 * snapshot, team-boundary workspace scope discovery, and the host-requirement
 * consent plans. The package ENGINE (source parsing, store population, lock v2
 * writing, capability indexing, trust) is workstream 1; the functions here
 * consume its on-disk shapes (oas-package.json, oas-lock.json packages map,
 * <scope>/.agents/packages/installed/<slug>/) and are built against
 * contract-level fixtures until the engine API is frozen.
 *
 * Runtime-neutral and dependency-free, like lib/core.mjs.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import {
  OAS_LOCK_FILE, capabilityIntegrity, configChain, parseYamlNested, resolveOasConfig, validateConfigShape,
} from "./core.mjs";

/** sha256 tree integrity of an installed package root (same walk as capability integrity). */
export const packageIntegrity = capabilityIntegrity;

// ---------- package store & manifest ----------

export const OAS_PACKAGE_MANIFEST = "oas-package.json";
export const PACKAGES_DIRNAME = join(".agents", "packages");
export const INSTALLED_PACKAGES_SUBDIR = "installed";
export const installedPackagesDir = (level) => join(level, PACKAGES_DIRNAME, INSTALLED_PACKAGES_SUBDIR);

/** Directory slug of a package id inside the installed store. Per the frozen
 * engine contract, the identity charset already forbids `/` and `@`, so the
 * slug is the identity itself (made filesystem-safe defensively). */
export const packageSlug = (id) => String(id).replace(/[/@]+/g, "-");

// Frozen contract charsets (docs/oas-package.schema.json on the engine branch).
const PACKAGE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Throw an Error carrying a stable contract error code (engine taxonomy §4). */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

/** Resolve a package-relative path and enforce containment inside the package after symlink resolution. */
function packageRelativePath(pkgDir, rel, what, pkgId) {
  if (typeof rel !== "string" || !rel.trim()) fail("invalid-package-manifest", `package ${pkgId}: ${what} must be a non-empty package-relative path`);
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) fail("path-escape", `package ${pkgId}: ${what} must stay inside the package: ${rel}`);
  const abs = join(pkgDir, rel);
  if (existsSync(abs)) {
    const fromRoot = relative(realpathSync(pkgDir), realpathSync(abs));
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      fail("path-escape", `package ${pkgId}: ${what} escapes the package after symlink resolution: ${rel}`);
    }
  }
  return abs;
}

/** Load and validate <dir>/oas-package.json. Returns the manifest annotated with _dir, or undefined when absent. */
export function loadPackageManifest(dir) {
  const file = join(dir, OAS_PACKAGE_MANIFEST);
  if (!existsSync(file)) return undefined;
  let m;
  try { m = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { fail("invalid-package-manifest", `invalid package manifest JSON ${file}: ${e.message}`); }
  if (!m || typeof m !== "object" || Array.isArray(m)) fail("invalid-package-manifest", `package manifest must be a JSON object: ${file}`);
  const id = m.package;
  if (!id || typeof id !== "string") fail("invalid-package-manifest", `package manifest needs "package": ${file}`);
  if (!PACKAGE_ID_RE.test(id)) fail("invalid-package-manifest", `invalid package id "${id}" in ${file}`);
  if (!m.version || !m.description) fail("invalid-package-manifest", `package ${id} manifest needs version and description (${file})`);
  if (m.capabilities !== undefined && (!Array.isArray(m.capabilities) || m.capabilities.some((c) => typeof c !== "string"))) {
    fail("invalid-package-manifest", `package ${id} "capabilities" must be an array of package-relative directories (${file})`);
  }
  for (const rel of m.capabilities || []) packageRelativePath(dir, rel, `capability path "${rel}"`, id);
  if (m.configs !== undefined && (typeof m.configs !== "object" || Array.isArray(m.configs) || m.configs === null)) {
    fail("invalid-package-manifest", `package ${id} "configs" must be a map of profile name → { path, description?, default? } (${file})`);
  }
  const defaults = [];
  for (const [name, spec] of Object.entries(m.configs || {})) {
    if (!PROFILE_NAME_RE.test(name)) fail("invalid-package-manifest", `package ${id} config profile name "${name}" must match ${PROFILE_NAME_RE} (${file})`);
    if (!spec || typeof spec !== "object" || typeof spec.path !== "string") fail("invalid-package-manifest", `package ${id} config profile "${name}" needs "path" (${file})`);
    packageRelativePath(dir, spec.path, `config profile "${name}" path`, id);
    if (spec.default) defaults.push(name);
  }
  if (defaults.length > 1) fail("invalid-package-manifest", `package ${id} marks multiple default config profiles (${defaults.join(", ")}) — at most one may be default (${file})`);
  if (m.dependencies !== undefined && (!Array.isArray(m.dependencies) || m.dependencies.some((d) => typeof d !== "string"))) {
    fail("invalid-package-manifest", `package ${id} "dependencies" must be an array of package source specifications (${file})`);
  }
  return { ...m, _dir: dir, _file: file };
}

/** Capability ids exported by a package: read each enumerated capability directory's oas.json. */
export function packageCapabilityIds(manifest) {
  const ids = [];
  for (const rel of manifest.capabilities || []) {
    const capDir = packageRelativePath(manifest._dir, rel, `capability path "${rel}"`, manifest.package);
    const mf = join(capDir, "oas.json");
    if (!existsSync(mf)) fail("invalid-package-manifest", `package ${manifest.package}: capability path "${rel}" has no oas.json`);
    let cap;
    try { cap = JSON.parse(readFileSync(mf, "utf8")); }
    catch (e) { fail("invalid-package-manifest", `package ${manifest.package}: ${rel}/oas.json is invalid JSON: ${e.message}`); }
    if (!cap || typeof cap !== "object" || !cap.capability) fail("invalid-package-manifest", `package ${manifest.package}: ${rel}/oas.json has no "capability"`);
    ids.push(cap.capability);
  }
  return ids;
}

/** Capability manifest (oas.json) of a capability id within one package, or undefined. */
export function packageCapabilityManifest(manifest, capabilityId) {
  for (const rel of manifest.capabilities || []) {
    const mf = join(manifest._dir, rel, "oas.json");
    if (!existsSync(mf)) continue;
    let cap;
    try { cap = JSON.parse(readFileSync(mf, "utf8")); } catch { continue; }
    if (cap && typeof cap === "object" && cap.capability === capabilityId) return { ...cap, _dir: join(manifest._dir, rel) };
  }
  return undefined;
}

// ---------- lock v2 reading ----------

/** Read one scope's oas-lock.json, split by contract shape: v2 packages vs legacy v1 capabilities. */
function readLockAt(levelDir) {
  const file = join(levelDir, OAS_LOCK_FILE);
  if (!existsSync(file)) return undefined;
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  return { file, level: levelDir, packages: parsed.packages || {}, capabilities: parsed.capabilities || {}, lockfileVersion: parsed.lockfileVersion };
}

/** Read the lock v2 "packages" map at one scope. Returns {} when absent or v1-only. */
export function readPackageLocksAt(levelDir) {
  const lock = readLockAt(levelDir);
  const out = {};
  for (const [id, entry] of Object.entries(lock?.packages || {})) out[id] = { ...entry, _file: lock.file, _level: levelDir };
  return out;
}

/** Merged package locks visible from a directory's config chain (closest scope
 * wins per package identity). Matches the frozen engine contract shape:
 * { packages, legacy } — legacy v1 files are surfaced separately, untouched. */
export function readPackageLocks(startDir) {
  const packages = {};
  const legacy = [];
  for (const cfg of [...configChain(startDir)].reverse()) {
    Object.assign(packages, readPackageLocksAt(cfg._level));
    const lock = readLockAt(cfg._level);
    // Legacy v1 files are surfaced separately and untouched — including empty
    // ones ({ lockfileVersion: 1, capabilities: {} }): consumers must be able
    // to see that the scope still carries a legacy lock.
    if (lock && (lock.lockfileVersion === 1 || Object.keys(lock.capabilities).length)) {
      legacy.push({ file: lock.file, level: lock.level, capabilities: lock.capabilities });
    }
  }
  return { packages, legacy };
}

/** Installed store directory of a locked package at its lock scope, if present. */
export function installedPackageDir(lock, id) {
  const dir = join(installedPackagesDir(lock._level), packageSlug(id));
  return existsSync(join(dir, OAS_PACKAGE_MANIFEST)) ? dir : undefined;
}

/** Capability ids supplied by the visible locked packages of a scope (lock v2 metadata). */
export function lockedPackageCapabilities(startDir) {
  const out = new Map(); // capability id → [package ids]
  for (const [pkgId, lock] of Object.entries(readPackageLocks(startDir).packages)) {
    for (const cap of lock.capabilities || []) {
      if (!out.has(cap)) out.set(cap, []);
      out.get(cap).push(pkgId);
    }
  }
  return out;
}

// ---------- phase-1 acquisition seam (frozen contract signatures; engine M2 replaces the bodies) ----------

/** Resolve a package's full dependency closure from source directories.
 * Phase-1 seam: local-path dependency specs only ("./dep", "/abs", "path:./dep"),
 * resolved against the depending package's root. Detects cycles
 * (dependency-cycle), identity collisions (duplicate-package-identity), and
 * duplicate exported capability ids (duplicate-capability-id), all with
 * provenance. Returns ordered entries [{ id, dir, manifest, capabilities }],
 * root first. */
export function resolvePackageClosure(rootDir) {
  const entries = new Map(); // id → { id, dir, manifest, capabilities }
  const inProgress = new Set();
  const capOwners = new Map(); // capability id → package id
  const visit = (dir, chain) => {
    const manifest = loadPackageManifest(dir);
    if (!manifest) fail("invalid-package-manifest", `${dir} has no ${OAS_PACKAGE_MANIFEST}`);
    const id = manifest.package;
    if (inProgress.has(id)) fail("dependency-cycle", `package dependency cycle: ${[...chain, id].join(" → ")}`);
    if (entries.has(id)) {
      if (realpathSync(entries.get(id).dir) !== realpathSync(dir)) fail("duplicate-package-identity", `two sources claim package identity "${id}": ${entries.get(id).dir} and ${dir}`);
      return;
    }
    inProgress.add(id);
    const capabilities = packageCapabilityIds(manifest);
    for (const cap of capabilities) {
      if (capOwners.has(cap)) fail("duplicate-capability-id", `capability "${cap}" is exported by both ${capOwners.get(cap)} and ${id}`);
      capOwners.set(cap, id);
    }
    entries.set(id, { id, dir, manifest, capabilities });
    for (const dep of manifest.dependencies || []) {
      const spec = String(dep).startsWith("path:") ? String(dep).slice(5) : String(dep);
      if (!spec.startsWith(".") && !isAbsolute(spec)) fail("invalid-source", `package ${id} dependency "${dep}": the phase-1 seam resolves local-path dependencies only (git/catalog land with the engine)`);
      visit(isAbsolute(spec) ? spec : resolve(dir, spec), [...chain, id]);
    }
    inProgress.delete(id);
  };
  visit(resolve(rootDir), []);
  return [...entries.values()];
}

/** Write/replace one package's lock entry (creates a lockfileVersion 2 file).
 * Refuses to write into a v1 file: code "legacy-lock" (migrate first). */
export function writePackageLock(levelDir, packageId, entry) {
  const file = join(levelDir, OAS_LOCK_FILE);
  let parsed = { lockfileVersion: 2, packages: {} };
  if (existsSync(file)) {
    try { parsed = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { fail("legacy-lock", `unreadable ${file}: ${e.message}`); }
    if (parsed?.lockfileVersion === 1 || (parsed?.capabilities && !parsed?.packages)) {
      fail("legacy-lock", `${file} is a lockfileVersion 1 capability lock — migrate it before writing package locks`);
    }
  }
  parsed.lockfileVersion = 2; parsed.packages ||= {};
  parsed.packages[packageId] = entry;
  writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
  return file;
}

/** Acquire a package closure at a scope: resolve the root source, validate the
 * whole closure, materialize every package into the installed store, and
 * exact-lock the closure. Activates nothing.
 * Phase-1 seam of the frozen contract signature: local-path sources only;
 * git/catalog acquisition lands with the engine (M2).
 * @returns {{ root, installed: [{ package, version, commit, integrity, source, capabilities }], lockFile }} */
export function acquirePackage(levelDir, spec) {
  const raw = String(spec).startsWith("path:") ? String(spec).slice(5) : String(spec);
  if (!raw.startsWith(".") && !raw.startsWith("/") && !raw.startsWith("~")) {
    fail("invalid-source", `"${spec}": the phase-1 acquisition seam supports local paths only (git/catalog land with the engine)`);
  }
  const rootDir = resolve(raw.replace(/^~\//, `${process.env.HOME || ""}/`));
  const closure = resolvePackageClosure(rootDir);
  const installed = [];
  const staged = [];
  try {
    for (const entry of closure) {
      const dest = join(installedPackagesDir(levelDir), packageSlug(entry.id));
      if (!existsSync(join(dest, OAS_PACKAGE_MANIFEST))) {
        mkdirSync(join(installedPackagesDir(levelDir)), { recursive: true });
        execFileSync("cp", ["-R", entry.dir, dest]);
        staged.push(dest);
      } else {
        const existing = loadPackageManifest(dest);
        if (existing.package !== entry.id) fail("duplicate-package-identity", `installed store at ${dest} provides "${existing.package}", acquisition expects "${entry.id}"`);
      }
      const integrity = packageIntegrity(dest);
      let commit = "local";
      try { commit = execFileSync("git", ["-C", entry.dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "local"; } catch { /* not a git checkout */ }
      const record = {
        package: entry.id, version: entry.manifest.version, commit, integrity,
        source: `path:${resolve(entry.dir)}`, capabilities: entry.capabilities,
      };
      installed.push(record);
    }
    // Lock the whole closure together — only after every member materialized.
    let lockFile;
    for (const rec of installed) {
      const entry = closure.find((c) => c.id === rec.package);
      lockFile = writePackageLock(levelDir, rec.package, {
        source: rec.source, version: rec.version, commit: rec.commit, integrity: rec.integrity,
        capabilities: rec.capabilities,
        dependencies: (entry.manifest.dependencies || []).map((d) => {
          const p = String(d).startsWith("path:") ? String(d).slice(5) : String(d);
          const depDir = isAbsolute(p) ? p : resolve(entry.dir, p);
          return closure.find((c) => realpathSync(c.dir) === realpathSync(depDir))?.id || d;
        }),
        trustedCapabilities: [],
      });
    }
    return { root: closure[0].id, installed, lockFile };
  } catch (e) {
    for (const dest of staged) rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/** Restore a scope chain's stores exactly from their v2 locks: for each locked
 * package whose artifact is missing, re-fetch the exact source, verify tree
 * integrity and the lock's capabilities list, and install. Never advances a
 * ref. NO team-boundary recursion (workstream 2 layers that on top).
 * Phase-1 seam: path sources only; git/catalog restore lands with the engine.
 * @returns [{ package, level, status: "restored"|"ok"|"failed", reason? }] */
export function restorePackages(startDir, { levels: onlyLevels } = {}) {
  const report = [];
  let levels = onlyLevels ? onlyLevels.map((d) => resolve(d)) : [];
  if (!onlyLevels) {
    for (const cfg of [...configChain(startDir)].reverse()) levels.push(cfg._level);
    if (!levels.includes(resolve(startDir))) levels.push(resolve(startDir));
  }
  for (const level of levels) {
    for (const [id, lock] of Object.entries(readPackageLocksAt(level))) {
      const dest = join(installedPackagesDir(level), packageSlug(id));
      if (existsSync(join(dest, OAS_PACKAGE_MANIFEST))) {
        const integrity = packageIntegrity(dest);
        if (integrity !== lock.integrity) report.push({ package: id, level, status: "failed", reason: `integrity-drift: installed tree ${integrity} ≠ locked ${lock.integrity}` });
        else report.push({ package: id, level, status: "ok", dir: dest });
        continue;
      }
      const src = String(lock.source || "");
      if (!src.startsWith("path:")) { report.push({ package: id, level, status: "failed", reason: `the phase-1 restore seam supports path sources only (locked source: ${src || "unknown"}) — git/catalog restore lands with the engine` }); continue; }
      const from = src.slice(5);
      try {
        if (!existsSync(join(from, OAS_PACKAGE_MANIFEST))) fail("invalid-source", `locked source has no ${OAS_PACKAGE_MANIFEST}: ${from}`);
        mkdirSync(installedPackagesDir(level), { recursive: true });
        execFileSync("cp", ["-R", from, dest]);
        const integrity = packageIntegrity(dest);
        if (integrity !== lock.integrity) fail("integrity-drift", `restored tree ${integrity} does not match locked ${lock.integrity}; the source has drifted — reacquire explicitly`);
        const m = loadPackageManifest(dest);
        const caps = packageCapabilityIds(m);
        if (JSON.stringify([...caps].sort()) !== JSON.stringify([...(lock.capabilities || [])].sort())) {
          fail("capability-list-mismatch", `lock capabilities [${(lock.capabilities || []).join(", ")}] disagree with restored manifest [${caps.join(", ")}]`);
        }
        report.push({ package: id, level, status: "restored", dir: dest, integrity });
      } catch (e) {
        rmSync(dest, { recursive: true, force: true });
        report.push({ package: id, level, status: "failed", reason: e.message });
      }
    }
  }
  return report;
}

// ---------- package sources (phase-1: local path, installed id, git URL for profile reads) ----------

/** Resolve a package source to a readable manifest for profile adoption/diff.
 * Phase 1 supports: a local path, an installed/locked package id visible from
 * dir, and a raw Git URL (shallow clone into tmpDir provided by the caller).
 * Returns { manifest, commit? }. The engine's resolver replaces this in phase 2. */
export function resolvePackageSource(src, dir, { clone } = {}) {
  const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(src);
  const isPath = !isUrl && (src.startsWith(".") || src.startsWith("/") || src.startsWith("~"));
  if (isPath) {
    const p = resolve(src.replace(/^~\//, `${process.env.HOME || ""}/`));
    const manifest = loadPackageManifest(p);
    if (!manifest) throw new Error(`${p} has no ${OAS_PACKAGE_MANIFEST}`);
    let commit;
    try { commit = execFileSync("git", ["-C", p, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not a git checkout */ }
    return { manifest, commit, source: `path:${p}` };
  }
  if (isUrl) {
    if (!clone) throw new Error(`git package sources need a clone directory (internal)`);
    execFileSync("git", ["clone", "-q", "--depth", "1", src, clone], { stdio: "inherit" });
    const manifest = loadPackageManifest(clone);
    if (!manifest) throw new Error(`package repo has no ${OAS_PACKAGE_MANIFEST} on its default branch: ${src}`);
    const commit = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return { manifest, commit, source: `git:${src}` };
  }
  // Installed/locked package id visible from dir. The dir's own lock is read
  // directly too: during `oas init --package` no oas-config.yaml exists at the
  // scope yet, so configChain cannot see it (init acquires before config exists).
  const lock = { ...readPackageLocks(dir).packages, ...readPackageLocksAt(dir) }[src];
  if (!lock) fail("invalid-source", `"${src}" is not a locked package id, local path, or git URL at ${dir} — acquire it first with \`oas install <source>\``);
  const pkgDir = installedPackageDir(lock, src);
  if (!pkgDir) throw new Error(`package ${src} is locked in ${lock._file} but not installed — run \`oas install\``);
  const manifest = loadPackageManifest(pkgDir);
  if (!manifest) throw new Error(`installed package ${src} has no ${OAS_PACKAGE_MANIFEST}: ${pkgDir}`);
  if (manifest.package !== src) throw new Error(`installed store at ${pkgDir} provides "${manifest.package}", lock expects "${src}"`);
  return { manifest, commit: lock.commit, source: lock.source };
}

// ---------- config profiles ----------

/** Choose a profile: explicit name, else the single marked default, else the only profile.
 * Multiple unmarked profiles require an explicit choice. Thrown errors carry
 * typed WS2 codes: E_NO_PROFILES, E_PROFILE_NOT_FOUND, E_PROFILE_AMBIGUOUS. */
export function selectProfile(manifest, name) {
  const configs = manifest.configs || {};
  const names = Object.keys(configs);
  if (!names.length) fail("E_NO_PROFILES", `package ${manifest.package} exports no config profiles`);
  if (name) {
    if (!configs[name]) fail("E_PROFILE_NOT_FOUND", `package ${manifest.package} has no config profile "${name}" (profiles: ${names.join(", ")})`);
    return { name, ...configs[name] };
  }
  const marked = names.filter((n) => configs[n].default);
  if (marked.length === 1) return { name: marked[0], ...configs[marked[0]] };
  if (names.length === 1) return { name: names[0], ...configs[names[0]] };
  fail("E_PROFILE_AMBIGUOUS", `package ${manifest.package} has multiple config profiles and none marked default (${names.join(", ")}) — pass --config <name>`);
}

/** Read a profile's config text from the package. */
export function readProfileText(manifest, profile) {
  const abs = packageRelativePath(manifest._dir, profile.path, `config profile "${profile.name}" path`, manifest.package);
  if (!existsSync(abs)) throw new Error(`package ${manifest.package}: config profile "${profile.name}" file missing: ${profile.path}`);
  return readFileSync(abs, "utf8");
}

const AGENT_TYPE_RE = /^[a-z][a-z0-9-]*$/;

/** Validate one package config profile before adoption. Returns a list of error strings (empty = valid).
 * Checks (per the Decision §3): config schema validity; every referenced
 * installed capability supplied by the package dependency closure; referenced
 * layers agree with capability manifests; agent types syntactically valid;
 * no paths escaping the eventual target scope. */
export function validateProfile(manifest, profile, { dependencyCapabilities = [] } = {}) {
  const errors = [];
  const where = `profile "${profile.name}" of package ${manifest.package}`;
  let cfg;
  try {
    cfg = parseYamlNested(readProfileText(manifest, profile));
    validateConfigShape(cfg, `${where} (${profile.path})`);
  } catch (e) { return [e.message]; }

  const supplied = new Set([...packageCapabilityIds(manifest), ...dependencyCapabilities]);
  const entries = [];
  const caps = cfg.capabilities || {};
  for (const [layer, entry] of Object.entries(caps.layers || {})) {
    if (entry && typeof entry === "object") entries.push({ id: entry.capability, entry, slot: layer });
  }
  for (const [id, entry] of Object.entries(caps.additive || {})) entries.push({ id, entry: entry && typeof entry === "object" ? entry : {}, slot: undefined });

  for (const { id, entry, slot } of entries) {
    const from = String(entry.from || "installed");
    if (from.startsWith("path:")) { errors.push(`${where}: capability ${id} uses "from: ${from}" — profiles must reference installed capabilities, not host paths`); continue; }
    if (from === "installed" && !supplied.has(id)) {
      errors.push(`${where}: capability ${id} is not supplied by the package or its dependency closure (supplied: ${[...supplied].join(", ") || "none"})`);
      continue;
    }
    if (slot) {
      const capMan = packageCapabilityManifest(manifest, id);
      if (capMan && capMan.layer !== slot) errors.push(`${where}: layer ${slot} binds ${id}, but its manifest declares layer "${capMan.layer || "none"}"`);
    }
    const override = entry["injection-override"];
    if (typeof override === "string" && (isAbsolute(override) || override.split(/[\\/]/).includes(".."))) {
      errors.push(`${where}: capability ${id} injection-override escapes the target scope: ${override}`);
    }
  }
  for (const [name] of Object.entries(cfg["agent-types"] || {})) {
    if (!AGENT_TYPE_RE.test(name)) errors.push(`${where}: agent type "${name}" must be lowercase alphanumeric/hyphens`);
  }
  for (const [mode, wm] of Object.entries(cfg["work-modes"] || {})) {
    const setup = wm && typeof wm === "object" ? wm.setup : undefined;
    if (typeof setup === "string" && (isAbsolute(setup) || setup.split(/[\\/]/).includes(".."))) {
      errors.push(`${where}: work-modes.${mode}.setup escapes the target scope: ${setup}`);
    }
  }
  const oasOverride = cfg.oas && typeof cfg.oas === "object" ? cfg.oas["injection-override"] : undefined;
  if (typeof oasOverride === "string" && (isAbsolute(oasOverride) || oasOverride.split(/[\\/]/).includes(".."))) {
    errors.push(`${where}: oas.injection-override escapes the target scope: ${oasOverride}`);
  }
  return errors;
}

/** Snapshot provenance header written into an adopted profile config. */
export function profileProvenanceHeader({ pkg, version, profile, commit }) {
  const at = commit ? `@${String(commit).slice(0, 12)}` : version ? `@${version}` : "";
  return `# package: ${pkg}${at} profile: ${profile} (snapshot — package updates never rewrite this file; compare with \`oas config diff --package ${pkg} --config ${profile}\`)`;
}

/** Parse the snapshot provenance from adopted config text, or undefined. */
export function parseProfileProvenance(text) {
  const m = String(text).match(/^# package: (\S+?)(?:@(\S+))? profile: (\S+) /m);
  if (!m) return undefined;
  return { package: m[1], ref: m[2], profile: m[3] };
}

/** Line-level diff (report-only) between the local snapshot and the package's current profile text. */
export function diffConfigTexts(localText, packageText) {
  const a = String(localText).replace(/\n*$/, "").split("\n");
  const b = String(packageText).replace(/\n*$/, "").split("\n");
  // LCS-based minimal line diff — small configs, O(n*m) is fine.
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "local", line: a[i] }); i++; }
    else { out.push({ kind: "package", line: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: "local", line: a[i++] });
  while (j < m) out.push({ kind: "package", line: b[j++] });
  return out;
}

// ---------- team-boundary workspace scope discovery ----------

/** Directory names pruned during descendant scope discovery (dependency/vendor trees). */
export const PRUNED_DIR_NAMES = new Set([".git", "node_modules", "vendor", ".venv", "venv", "bower_components", ".direnv"]);

const isScopeDir = (dir) => existsSync(join(dir, "oas-config.yaml")) || existsSync(join(dir, OAS_LOCK_FILE));
const declaresTeam = (dir) => {
  const file = join(dir, "oas-config.yaml");
  if (!existsSync(file)) return false;
  try { return !!parseYamlNested(readFileSync(file, "utf8")).team; } catch { return false; }
};

/** Deterministic path-order discovery of descendant scopes inside a team boundary.
 * Prunes .git, generated package/capability stores, dependency/vendor dirs,
 * agent instance homes/worktrees, and nested team boundaries. The boundary
 * itself is NOT included. Returns sorted absolute paths. */
export function discoverWorkspaceScopes(boundary) {
  const out = [];
  const root = resolve(boundary);
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort((x, y) => x.localeCompare(y));
    for (const name of names) {
      if (PRUNED_DIR_NAMES.has(name)) continue;
      const child = join(dir, name);
      // Generated stores (.agents: capability/package stores, injections) never
      // contain deployment scopes; agent instance homes/worktrees and local
      // souls are runtime state, not workspace repositories.
      if (name === ".agents") continue;
      if (name === "local-agents") continue;
      if (name === "instances" && existsSync(join(dir, "soul"))) continue;
      // Nested team boundary: a descendant scope declaring its own team: is its own reconciliation unit.
      if (declaresTeam(child)) continue;
      if (isScopeDir(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

// ---------- host requirements (structured, consented) ----------

/** Allowlisted install methods. Recipes are data; commands are argv arrays (no shell, no sudo, no auth). */
export const REQUIREMENT_MANAGERS = {
  "npm-global": {
    scope: "user-level (npm global prefix)",
    plan: (method) => {
      const pkg = String(method.package || "");
      if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~><=-]+)?$/i.test(pkg)) throw new Error(`npm-global package spec is not a plain package name: "${pkg}"`);
      return { argv: ["npm", "install", "-g", pkg], source: `npm registry (${pkg})` };
    },
  },
  brew: {
    scope: "user-level (Homebrew prefix)",
    plan: (method) => {
      const formula = String(method.formula || method.package || "");
      if (!/^[a-z0-9][\w.@/-]*$/i.test(formula)) throw new Error(`brew formula is not a plain formula name: "${formula}"`);
      return { argv: ["brew", "install", formula], source: `Homebrew (${formula})` };
    },
  },
  "download-checksum": {
    scope: "user-level",
    plan: () => { throw new Error("download-with-checksum installs are not implemented yet — use the documented install URL"); },
  },
};

/** Normalize a manifest `requires` entry to the structured form.
 * Legacy shape: { command, why, install: "https://…" }. */
export function normalizeRequirement(req) {
  if (!req || typeof req !== "object" || !req.command) return undefined;
  const install = req.install;
  if (typeof install === "string" || install === undefined) {
    return { command: req.command, why: req.why, install: { docs: typeof install === "string" ? install : undefined, methods: [] } };
  }
  if (typeof install !== "object") return { command: req.command, why: req.why, install: { methods: [] } };
  const methods = Array.isArray(install.methods) ? install.methods.filter((m) => m && typeof m === "object") : [];
  return { command: req.command, why: req.why, install: { docs: install.docs, methods } };
}

/** Is a command on PATH? (dependency-free `which`). */
export function commandOnPath(cmd, env = process.env) {
  if (!cmd || /[\\/]/.test(cmd)) return false;
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try { const st = statSync(join(dir, cmd)); if (st.isFile() && (st.mode & 0o111)) return true; } catch { /* keep looking */ }
  }
  return false;
}

/** Build the informed-consent install plan for one requirement on this host, or an explanation why none applies.
 * Never uses sudo, shell strings, or authentication. */
export function requirementInstallPlan(req, { platform = process.platform } = {}) {
  const r = normalizeRequirement(req);
  if (!r) return undefined;
  const applicable = (r.install.methods || []).filter((m) => !m.platform || m.platform === platform);
  for (const method of applicable) {
    const manager = REQUIREMENT_MANAGERS[method.manager];
    if (!manager) continue; // non-allowlisted methods are ignored, never executed
    try {
      const { argv, source } = manager.plan(method);
      return {
        command: r.command, why: r.why, docs: r.install.docs,
        manager: method.manager, argv, source, scope: manager.scope,
        version: (String(method.package || method.formula || "").match(/.@([^@]+)$/) || [])[1],
      };
    } catch (e) {
      return { command: r.command, why: r.why, docs: r.install.docs, unavailable: e.message };
    }
  }
  return { command: r.command, why: r.why, docs: r.install.docs, unavailable: applicable.length ? "no allowlisted install method for this host" : "no install method matches this platform" };
}

/** Gate: a requirement's command must be a safe executable basename/CLI token —
 * no path separators, whitespace, leading dash, or shell syntax. Fail closed. */
export function safeRequirementCommand(cmd) {
  return typeof cmd === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(cmd);
}

/** Aggregate missing host requirements across reconciled scopes, only for
 * capabilities activated somewhere in those scopes, deduplicated by command.
 * Returns [{ command, why, docs, plan, requestedBy: [{ capability, scope }],
 *            invalid?, conflict? }].
 * Fail-closed identity rules:
 * - a command that is not a safe executable token is flagged { invalid } with
 *   NO install plan — it can never be consented or executed;
 * - two active capabilities requesting the SAME command with NON-identical
 *   plans produce one deterministic conflict entry ({ conflict: { plans } },
 *   provenance-rich, no plan, no consent) — identical plans merge requestedBy. */
export function aggregateMissingRequirements(scopes, { platform = process.platform, env = process.env } = {}) {
  const byCommand = new Map();
  for (const scope of scopes) {
    let resolved;
    try { resolved = resolveOasConfig(scope); } catch { continue; /* scope failures are reported by the reconciler */ }
    for (const cap of resolved.capabilities || []) {
      for (const raw of cap.manifest?.requires || []) {
        const r = normalizeRequirement(raw);
        if (!r) continue;
        if (!safeRequirementCommand(r.command)) {
          const key = `\u0000invalid:${r.command}`;
          if (!byCommand.has(key)) byCommand.set(key, { command: r.command, why: r.why, docs: r.install.docs, plan: null, invalid: "requirement command is not a safe executable name (no paths, whitespace, dashes-first, or shell syntax)", requestedBy: [] });
          const bad = byCommand.get(key);
          if (!bad.requestedBy.some((x) => x.capability === cap.id && x.scope === scope)) bad.requestedBy.push({ capability: cap.id, scope });
          continue;
        }
        if (commandOnPath(r.command, env)) continue;
        const plan = requirementInstallPlan(raw, { platform });
        if (!byCommand.has(r.command)) {
          byCommand.set(r.command, { command: r.command, why: r.why, docs: r.install.docs, plan, requestedBy: [], _plans: [{ plan, capability: cap.id, scope }] });
        } else {
          const agg = byCommand.get(r.command);
          // Plan identity: the executable argv (or unavailability) must match exactly.
          const planKey = (p) => JSON.stringify(p?.argv || p?.unavailable || null);
          if (!agg.conflict && planKey(agg.plan) !== planKey(plan)) {
            agg._plans.push({ plan, capability: cap.id, scope });
            agg.conflict = { plans: agg._plans.map((x) => ({ capability: x.capability, scope: x.scope, argv: x.plan?.argv || null, unavailable: x.plan?.unavailable || null })) };
            agg.plan = null; // conflicting recipes: nothing is installable or consentable
          } else if (!agg.conflict) {
            agg._plans.push({ plan, capability: cap.id, scope });
          }
        }
        const agg = byCommand.get(r.command);
        if (!agg.requestedBy.some((x) => x.capability === cap.id && x.scope === scope)) agg.requestedBy.push({ capability: cap.id, scope });
      }
    }
  }
  return [...byCommand.values()].map(({ _plans, ...rest }) => rest).sort((a, b) => a.command.localeCompare(b.command));
}

/** Execute one consented install plan (argv, no shell) and verify the command lands on PATH. */
export function runRequirementInstall(plan, { env = process.env, stdio = "inherit" } = {}) {
  if (!plan || !plan.argv) throw new Error(`no executable install plan for "${plan?.command}"`);
  execFileSync(plan.argv[0], plan.argv.slice(1), { stdio, env });
  const onPath = commandOnPath(plan.command, env);
  return { command: plan.command, installed: true, onPath };
}
