// Capability-materialization engine tests (docs/design/package-engine-contract.md).
//
// Scope: the ENGINE surface in lib/core.mjs — source parsing, manifest
// validation, the lock, staging/projection, restore/update/remove/trust, the
// locked-template reader, and v1 migration. CLI-driving tests live in the CLI
// lane's suite.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  acquirePackage, applyLegacyLockMigration, approveCapability, assertCapabilitySelfContained,
  capabilityArtifactIntegrity, capabilityManifest, capabilityManifests, capabilityTrust,
  copyTreeSafe, ensureInstalledGitignore, installedCapabilityDir, listInstalledPackages,
  loadPackageManifestAt, materializeCapabilityDeps, migrateLegacyLock, normalizePackagePath,
  packageIntegrity, parseLockFileStrict, parsePackageSource, platformVariantLockPackages,
  readLockedConfigTemplates, readPackageLocks, removePackage, resolveOasConfig, restorePackages,
  updatePackage, validateCapabilityLockEntry, validateLockEntry, writeCapabilityLock,
  writeCapabilityLockEntry, writePackageLock,
  CAPABILITY_INSTALLATION_FILE, DEFAULT_PACKAGE_PATH, LOCKFILE_VERSION, OAS_LOCK_FILE,
} from "../lib/core.mjs";

function temp() { return mkdtempSync(join(tmpdir(), "oas-pkg-test-")); }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function gitify(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
function gitCommit(dir, msg = "next") {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", msg]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
/** Author a package source tree: oas-package.json + capability dirs. */
function pkgSource(dir, manifest, capabilities = {}) {
  const caps = [];
  for (const [rel, cm] of Object.entries(capabilities)) {
    caps.push(rel);
    write(join(dir, rel, "oas.json"), JSON.stringify({ version: "1.0.0", description: "cap", ...cm }, null, 2));
  }
  write(join(dir, "oas-package.json"), JSON.stringify({ package: `x.${dir.split("/").pop().toLowerCase().replace(/[^a-z0-9._-]/g, "")}`, version: "1.0.0", description: "pkg", compatibility: { oas: ">=0.1.0" }, capabilities: caps, ...manifest }, null, 2));
  return dir;
}
/** Activation of the resolved chain, as plain capability IDs. */
function activeIds(dir) { return resolveOasConfig(dir, "any").capabilities.map((c) => c.id).sort(); }
/** A scope with an oas-config.yaml so the config chain sees it. */
function scope(base, name = "scope", config = "name: test\n") {
  const dir = join(base, name);
  write(join(dir, "oas-config.yaml"), config);
  return dir;
}
function lockOf(dir) { return JSON.parse(readFileSync(join(dir, OAS_LOCK_FILE), "utf8")); }
function artifact(dir, id) { return installedCapabilityDir(dir, id); }
function throwsCode(fn, code, label = code) {
  try { fn(); assert.fail(`expected ${label} but nothing was thrown`); }
  catch (e) { assert.equal(e.code, code, `${label}: got ${e.code} — ${e.message}`); return e; }
}

// ---------- source parsing ----------

test("parsePackageSource: git shorthand, raw URLs, paths, catalog ids, invalids", () => {
  assert.deepEqual(parsePackageSource("git:github.com/o/r@v1.0.0"), { kind: "git", url: "https://github.com/o/r.git", ref: "v1.0.0", packagePath: undefined, normalized: "git:https://github.com/o/r.git@v1.0.0" });
  assert.equal(parsePackageSource("git:github.com/o/r@v1#sub/dir").packagePath, "sub/dir");
  assert.equal(parsePackageSource("git:github.com/o/r@v1#./.").packagePath, ".");
  assert.equal(parsePackageSource("https://h/o/r.git@ref").normalized, "git:https://h/o/r.git@ref");
  assert.equal(parsePackageSource("oas.okf").normalized, "catalog:oas.okf");
  assert.equal(parsePackageSource("oas.okf@v1.4.0").normalized, "catalog:oas.okf@v1.4.0");
  // Local sources are EXACT directories: no fragment, always path "."
  assert.equal(parsePackageSource("/abs/dir").packagePath, ".");
  throwsCode(() => parsePackageSource("/abs/dir#sub"), "invalid-source", "local path with fragment");
  throwsCode(() => parsePackageSource("oas.okf#sub"), "invalid-source", "catalog with fragment");
  throwsCode(() => parsePackageSource("git:github.com/o/r#a#b"), "invalid-source", "double fragment");
  throwsCode(() => parsePackageSource("git:only/two"), "invalid-source", "bad shorthand");
  throwsCode(() => parsePackageSource(""), "invalid-source", "empty");
  // The default contained root is read, never hardcoded at a use site.
  assert.equal(DEFAULT_PACKAGE_PATH, "oas-package");
});

test("normalizePackagePath: canonical form, and fail-closed on ambient/absolute/traversal spellings", () => {
  for (const spelling of ["", ".", "./", "./."]) assert.equal(normalizePackagePath(spelling), ".");
  assert.equal(normalizePackagePath("a//b/"), "a/b");
  assert.equal(normalizePackagePath(undefined), undefined, "absent means absent, so the caller can apply its own default");
  throwsCode(() => normalizePackagePath("~/x"), "invalid-source", "tilde");
  throwsCode(() => normalizePackagePath("/abs"), "invalid-source", "absolute");
  throwsCode(() => normalizePackagePath("C:/x"), "invalid-source", "drive");
  throwsCode(() => normalizePackagePath("a\\b"), "invalid-source", "backslash");
  throwsCode(() => normalizePackagePath("a/../b"), "path-escape", "traversal");
  // A present null is a violation, not a fall-through to the caller's default.
  throwsCode(() => normalizePackagePath(null), "invalid-source", "null");
});

// ---------- manifest validation ----------

test("loadPackageManifestAt: capabilities are REQUIRED and non-empty — config-only and empty packages are rejected", () => {
  const t = temp();
  const ok = pkgSource(join(t, "ok"), {}, { "capabilities/a": { capability: "x.a" } });
  const m = loadPackageManifestAt(ok);
  assert.deepEqual(m._capabilities.map((c) => c.id), ["x.a"]);
  assert.equal(m._legacySpelling, false);

  const empty = join(t, "empty");
  write(join(empty, "oas-package.json"), JSON.stringify({ package: "x.empty", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: [] }));
  throwsCode(() => loadPackageManifestAt(empty), "invalid-package-manifest", "empty capabilities");

  const none = join(t, "none");
  write(join(none, "oas-package.json"), JSON.stringify({ package: "x.none", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" } }));
  throwsCode(() => loadPackageManifestAt(none), "invalid-package-manifest", "absent capabilities");

  const cfgOnly = join(t, "cfgonly");
  write(join(cfgOnly, "config-templates/d/oas-config.yaml"), "name: x\n");
  write(join(cfgOnly, "oas-package.json"), JSON.stringify({ package: "x.cfg", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: [], configTemplates: { d: { path: "config-templates/d/oas-config.yaml" } } }));
  throwsCode(() => loadPackageManifestAt(cfgOnly), "invalid-package-manifest", "config-only package");
});

test('legacy "." capability roots are discriminated by configTemplates, NEVER by configs', () => {
  const t = temp();
  // The published shape this compatibility exists for: oas.authoring@1.0.0 is
  // capabilities:["."] and ships NO template map in either spelling. Keying
  // acceptance on `configs` would strand it.
  const authoring = join(t, "authoring");
  write(join(authoring, "oas.json"), JSON.stringify({ capability: "oas.authoring", version: "1.0.0", description: "authoring" }));
  write(join(authoring, "oas-package.json"), JSON.stringify({ package: "oas.authoring", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["."] }));
  const m = loadPackageManifestAt(authoring);
  assert.deepEqual(m._capabilities.map((c) => c.rel), ["."]);
  assert.equal(m._legacySpelling, false, "no template map at all — the legacy spelling is not what makes it legacy");

  // Deprecated `configs` spelling with "." also reads.
  const withConfigs = join(t, "withconfigs");
  write(join(withConfigs, "oas.json"), JSON.stringify({ capability: "x.flat", version: "1.0.0", description: "d" }));
  write(join(withConfigs, "configs/d/oas-config.yaml"), "name: x\n");
  write(join(withConfigs, "oas-package.json"), JSON.stringify({ package: "x.flat", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["."], configs: { d: { path: "configs/d/oas-config.yaml" } } }));
  const legacy = loadPackageManifestAt(withConfigs);
  assert.equal(legacy._legacySpelling, true);
  assert.deepEqual(Object.keys(legacy._configTemplates), ["d"]);

  // A manifest carrying configTemplates is unambiguously new: "." is rejected.
  const modern = join(t, "modern");
  write(join(modern, "oas.json"), JSON.stringify({ capability: "x.new", version: "1.0.0", description: "d" }));
  write(join(modern, "config-templates/d/oas-config.yaml"), "name: x\n");
  write(join(modern, "oas-package.json"), JSON.stringify({ package: "x.new", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["."], configTemplates: { d: { path: "config-templates/d/oas-config.yaml" } } }));
  throwsCode(() => loadPackageManifestAt(modern), "invalid-package-manifest", 'new-format "."');

  // Both spellings at once is invalid.
  const both = join(t, "both");
  write(join(both, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.b", version: "1.0.0", description: "d" }));
  write(join(both, "c/oas-config.yaml"), "name: x\n");
  write(join(both, "oas-package.json"), JSON.stringify({ package: "x.both", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"], configs: { d: { path: "c/oas-config.yaml" } }, configTemplates: { d: { path: "c/oas-config.yaml" } } }));
  throwsCode(() => loadPackageManifestAt(both), "invalid-package-manifest", "both spellings");
});

test('"." remains exclusive with any other capability path', () => {
  const t = temp();
  const d = join(t, "p");
  write(join(d, "oas.json"), JSON.stringify({ capability: "x.root", version: "1.0.0", description: "d" }));
  write(join(d, "sub/oas.json"), JSON.stringify({ capability: "x.sub", version: "1.0.0", description: "d" }));
  write(join(d, "oas-package.json"), JSON.stringify({ package: "x.p", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: [".", "sub"] }));
  throwsCode(() => loadPackageManifestAt(d), "invalid-package-manifest", '"." with siblings');
});

test("loadPackageManifestAt: identity, unknown keys, missing paths, duplicate capability, multi-default, compatibility grammar", () => {
  const t = temp();
  const mk = (patch, caps = { "capabilities/a": { capability: "x.a" } }) => pkgSource(join(t, `p${Math.random().toString(36).slice(2)}`), { package: "x.p", ...patch }, caps);
  throwsCode(() => loadPackageManifestAt(mk({ package: "Bad Id" })), "invalid-package-manifest", "identity charset");
  throwsCode(() => loadPackageManifestAt(mk({ nope: 1 })), "invalid-package-manifest", "unknown key");
  throwsCode(() => loadPackageManifestAt(mk({ version: 1 })), "invalid-package-manifest", "numeric version");
  throwsCode(() => loadPackageManifestAt(mk({ dependencies: ["a", "a"] })), "invalid-package-manifest", "duplicate dependencies");
  // Two capability paths exporting one ID.
  throwsCode(() => loadPackageManifestAt(mk({}, { "capabilities/a": { capability: "x.dup" }, "capabilities/b": { capability: "x.dup" } })), "duplicate-capability-id", "same id twice");
  // compatibility.oas: required, exact grammar.
  for (const oas of [">=0.1.0", "^0.1.0", "0.1.0"]) loadPackageManifestAt(mk({ compatibility: { oas } }));
  for (const oas of ["banana", ">=1.2", "~1.2.3", ">= 1.2.3", 1]) {
    throwsCode(() => loadPackageManifestAt(mk({ compatibility: { oas } })), "invalid-package-manifest", `compat ${JSON.stringify(oas)}`);
  }
  const noCompat = mk({});
  const doc = JSON.parse(readFileSync(join(noCompat, "oas-package.json"), "utf8"));
  delete doc.compatibility;
  writeFileSync(join(noCompat, "oas-package.json"), JSON.stringify(doc));
  throwsCode(() => loadPackageManifestAt(noCompat), "invalid-package-manifest", "missing compatibility");
  // At most one default template.
  const multi = join(t, "multi");
  write(join(multi, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.a", version: "1.0.0", description: "d" }));
  write(join(multi, "c/a.yaml"), "a: 1\n"); write(join(multi, "c/b.yaml"), "b: 1\n");
  write(join(multi, "oas-package.json"), JSON.stringify({ package: "x.multi", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"], configTemplates: { a: { path: "c/a.yaml", default: true }, b: { path: "c/b.yaml", default: true } } }));
  throwsCode(() => loadPackageManifestAt(multi), "invalid-package-manifest", "two defaults");
});

test("loadPackageManifestAt: hostile roots are typed, never a TypeError", () => {
  const t = temp();
  for (const raw of ["null", '"str"', "[]", "3", "{"]) {
    const d = join(t, `h${Math.random().toString(36).slice(2)}`);
    write(join(d, "oas-package.json"), raw);
    throwsCode(() => loadPackageManifestAt(d), "invalid-package-manifest", `root ${raw}`);
  }
});

test("loadPackageManifestAt: declared paths cannot escape the package root, lexically or through a symlink", () => {
  const t = temp();
  const outside = join(t, "outside"); write(join(outside, "oas.json"), JSON.stringify({ capability: "x.out", version: "1.0.0", description: "d" }));
  const d = join(t, "p");
  write(join(d, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.a", version: "1.0.0", description: "d" }));
  write(join(d, "oas-package.json"), JSON.stringify({ package: "x.p", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["../outside"] }));
  throwsCode(() => loadPackageManifestAt(d), "path-escape", "lexical ..");
  symlinkSync(outside, join(d, "linked"));
  writeFileSync(join(d, "oas-package.json"), JSON.stringify({ package: "x.p", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["linked"] }));
  throwsCode(() => loadPackageManifestAt(d), "path-escape", "symlinked escape");
});

// ---------- self-containment ----------

test("assertCapabilitySelfContained: every declared resource must exist inside the capability root", () => {
  const t = temp();
  const cap = join(t, "cap");
  const manifest = { capability: "x.a", version: "1.0.0", description: "d", skills: ["skills/s"], inject: "inject.md", commands: { go: "bin/go.mjs run" }, hooks: { spawn: "bin/hook.mjs spawn" }, agents: ["agents/a"] };
  write(join(cap, "skills/s/SKILL.md"), "# s\n");
  write(join(cap, "inject.md"), "x\n");
  write(join(cap, "bin/go.mjs"), "//\n");
  write(join(cap, "bin/hook.mjs"), "//\n");
  write(join(cap, "agents/a/soul.yaml"), "name: a\n");
  assertCapabilitySelfContained(cap, manifest); // all present

  // A declared-but-missing artifact is not projectable.
  rmSync(join(cap, "inject.md"));
  throwsCode(() => assertCapabilitySelfContained(cap, manifest), "capability-not-self-contained", "missing inject");
  write(join(cap, "inject.md"), "x\n");

  // A resource reaching OUTSIDE the capability root — the package-only path case.
  write(join(t, "package-shared/SKILL.md"), "# shared\n");
  symlinkSync(join(t, "package-shared"), join(cap, "skills/shared"));
  throwsCode(() => assertCapabilitySelfContained(cap, { ...manifest, skills: ["skills/shared"] }), "capability-not-self-contained", "escaping skill tree");
  // ...and a descendant link that escapes, under a contained declared root.
  symlinkSync(join(t, "package-shared"), join(cap, "skills/s/nested"));
  throwsCode(() => assertCapabilitySelfContained(cap, manifest), "capability-not-self-contained", "escaping descendant");
});

test("acquire rejects a package whose capability is not self-contained instead of installing it broken", () => {
  const t = temp();
  const src = join(t, "src");
  write(join(src, "shared/SKILL.md"), "# shared\n");
  write(join(src, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.a", version: "1.0.0", description: "d", skills: ["../../shared"] }));
  write(join(src, "oas-package.json"), JSON.stringify({ package: "x.p", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"] }));
  const s = scope(t);
  throwsCode(() => acquirePackage(s, src), "path-escape", "package-only skill path");
  assert.equal(existsSync(join(s, OAS_LOCK_FILE)), false, "nothing locked");
  assert.equal(existsSync(artifact(s, "x.a")), false, "nothing installed");
});

// ---------- the lock ----------

test("lock round-trip: package rows are transport-only, capability rows carry version/provider/path/integrity/trust", () => {
  const t = temp();
  const s = scope(t);
  const pkgRow = { source: "path:/tmp/x", path: ".", version: "1.0.0", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] };
  writePackageLock(s, "x.p", pkgRow);
  writeCapabilityLockEntry(s, "x.a", { version: "2.0.0", package: "x.p", path: "capabilities/a", integrity: `sha256-${"b".repeat(64)}`, trusted: false });
  const doc = lockOf(s);
  assert.equal(doc.lockfileVersion, LOCKFILE_VERSION);
  assert.equal(doc.lockfileVersion, 2, "the capability-materialization lock IS lockfileVersion 2");
  assert.deepEqual(doc.packages["x.p"], pkgRow);
  assert.deepEqual(Object.keys(doc.capabilities["x.a"]).sort(), ["integrity", "package", "path", "trusted", "version"]);
  const read = readPackageLocks(s);
  assert.equal(read.packages["x.p"].version, "1.0.0");
  assert.equal(read.capabilities["x.a"].package, "x.p");
  assert.deepEqual(read.migration, [], "a current lock needs no migration");
  // Deleting rows.
  writeCapabilityLockEntry(s, "x.a", null);
  writePackageLock(s, "x.p", null);
  assert.deepEqual(lockOf(s), { lockfileVersion: 2, packages: {}, capabilities: {} });
});

test("dependencies is REQUIRED on every package row (empty array when none)", () => {
  const base = { source: "path:/tmp/x", path: ".", version: "1", commit: "local", integrity: `sha256-${"a".repeat(64)}` };
  throwsCode(() => validateLockEntry("x.p", base, { "x.p": base }), "invalid-lock", "absent dependencies");
  assert.equal(validateLockEntry("x.p", { ...base, dependencies: [] }, { "x.p": base }), true);
});

test("capability rows must reference a locked provider package", () => {
  const packages = { "x.p": { source: "path:/tmp/x", path: ".", version: "1", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] } };
  const row = { version: "1", package: "x.p", path: "capabilities/a", integrity: `sha256-${"b".repeat(64)}`, trusted: false };
  assert.equal(validateCapabilityLockEntry("x.a", row, packages), true);
  throwsCode(() => validateCapabilityLockEntry("x.a", { ...row, package: "x.missing" }, packages), "invalid-lock", "dangling provider");
  throwsCode(() => validateCapabilityLockEntry("x.a", { ...row, trusted: "yes" }, packages), "invalid-lock", "non-boolean trusted");
  throwsCode(() => validateCapabilityLockEntry("x.a", { ...row, path: "./a" }, packages), "invalid-lock", "non-canonical path");
});

test("validateLockEntry: source/commit pairing, canonical path, self-dependency, locked-graph cycle, duplicates", () => {
  const good = { source: "git:https://h/r.git@v1", path: "oas-package", version: "1", commit: "0".repeat(40), integrity: `sha256-${"a".repeat(64)}`, dependencies: [] };
  assert.equal(validateLockEntry("x.p", good, { "x.p": good }), true);
  throwsCode(() => validateLockEntry("x.p", { ...good, commit: "abc" }, { "x.p": good }), "invalid-lock", "short git commit");
  throwsCode(() => validateLockEntry("x.p", { ...good, source: "path:/d", commit: "0".repeat(40) }, {}), "invalid-lock", "path source needs commit local");
  throwsCode(() => validateLockEntry("x.p", { ...good, source: "path:/d", commit: "local", path: "sub" }, {}), "invalid-lock", "path source needs path .");
  throwsCode(() => validateLockEntry("x.p", { ...good, path: "sub/" }, { "x.p": good }), "invalid-lock", "non-canonical path");
  throwsCode(() => validateLockEntry("x.p", { ...good, dependencies: ["x.p"] }, { "x.p": good }), "invalid-lock", "self-dependency");
  throwsCode(() => validateLockEntry("x.p", { ...good, dependencies: ["x.q"] }, { "x.p": good }), "invalid-lock", "unlocked dependency");
  throwsCode(() => validateLockEntry("x.p", { ...good, dependencies: ["x.q", "x.q"] }, { "x.p": good, "x.q": good }), "invalid-lock", "duplicate dependency");
  // Reclassification defence: a payload that merely starts with a known scheme.
  for (const source of ["catalog:../evil", "path:relative/dir", "git:not-a-url", "git:https://h/r.git#frag"]) {
    throwsCode(() => validateLockEntry("x.p", { ...good, source }, { "x.p": good }), "invalid-lock", `source ${source}`);
  }
  // Cycle over the locked graph.
  const a = { ...good, dependencies: ["x.b"] }, b = { ...good, dependencies: ["x.a"] };
  throwsCode(() => validateLockEntry("x.a", a, { "x.a": a, "x.b": b }), "invalid-lock", "cycle");
});

test("unsupported transitional package-root v2 is rejected centrally, with NO side effects", () => {
  const t = temp();
  const row = { source: "path:/tmp/x", path: ".", version: "1", commit: "local", integrity: `sha256-${"a".repeat(64)}` };
  // Arm 1: nonempty, no top-level capability map.
  const a = scope(t, "a");
  write(join(a, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: { "x.p": { ...row, dependencies: [] } } }));
  const e1 = throwsCode(() => parseLockFileStrict(join(a, OAS_LOCK_FILE)), "invalid-lock", "no capability map");
  assert.match(e1.message, /unsupported transitional/i);
  assert.match(e1.message, /oas install/, "the message names the recovery");
  // Arm 2: a package row carrying a transitional field — own-property PRESENCE,
  // never truthiness, so EMPTY arrays still classify.
  for (const tell of [{ capabilities: [] }, { trustedCapabilities: [] }, { depsIntegrity: `sha256-${"c".repeat(64)}` }, { capabilities: ["x.a"], trustedCapabilities: [] }]) {
    const d = scope(t, `t${Math.random().toString(36).slice(2)}`);
    write(join(d, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: { "x.p": { ...row, dependencies: [], ...tell } }, capabilities: {} }));
    const e = throwsCode(() => parseLockFileStrict(join(d, OAS_LOCK_FILE)), "invalid-lock", `tell ${Object.keys(tell)}`);
    assert.match(e.message, /unsupported transitional/i);
  }
  // A dependency-free OLD row (capabilities/trustedCapabilities, no depsIntegrity).
  const dep = scope(t, "depfree");
  write(join(dep, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: { "x.p": { ...row, capabilities: ["x.a"], trustedCapabilities: ["x.a"] } }, capabilities: {} }));
  throwsCode(() => parseLockFileStrict(join(dep, OAS_LOCK_FILE)), "invalid-lock", "dependency-free old row");
  // path/dependencies are NEVER tells — the current shape retains both.
  const fine = scope(t, "fine");
  write(join(fine, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: { "x.p": { ...row, dependencies: [] } }, capabilities: {} }));
  assert.ok(parseLockFileStrict(join(fine, OAS_LOCK_FILE)), "path + dependencies are current-shape fields");
  // Rejection has no side effects: the bytes are untouched.
  const before = readFileSync(join(a, OAS_LOCK_FILE), "utf8");
  throwsCode(() => readPackageLocks(a), "invalid-lock", "read");
  throwsCode(() => listInstalledPackages(a), "invalid-lock", "list");
  throwsCode(() => restorePackages(a), "invalid-lock", "restore");
  assert.equal(readFileSync(join(a, OAS_LOCK_FILE), "utf8"), before, "no repair, no rewrite");
});

test("a STATE-FREE empty transitional document normalizes; an empty v1 stays pending explicit migration", () => {
  const t = temp();
  const e = scope(t, "empty2");
  write(join(e, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {} }));
  const strict = parseLockFileStrict(join(e, OAS_LOCK_FILE));
  assert.equal(strict.version, 2);
  assert.deepEqual(Object.keys(strict.packages), []);
  assert.deepEqual(Object.keys(strict.capabilities), []);

  const v1 = scope(t, "empty1");
  write(join(v1, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: {} }));
  const read = readPackageLocks(v1);
  assert.equal(read.migration[0].kind, "v1-empty", "an empty v1 SURFACES as pending format migration");
  assert.equal(read.legacy.length, 1);
  // ...and is never converted implicitly by a writer.
  throwsCode(() => writePackageLock(v1, "x.p", { source: "path:/d", path: ".", version: "1", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] }), "legacy-lock", "implicit empty-v1 conversion");
  assert.equal(lockOf(v1).lockfileVersion, 1, "bytes untouched");
});

test("writers refuse any v1 lock; only an ABSENT lock is a fresh document", () => {
  const t = temp();
  const s = scope(t);
  write(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: { "x.a": { source: "marketplace:x.a@1", version: "1", integrity: `sha256-${"a".repeat(64)}` } } }));
  throwsCode(() => writePackageLock(s, "x.p", { source: "path:/d", path: ".", version: "1", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] }), "legacy-lock", "package row into v1");
  throwsCode(() => writeCapabilityLockEntry(s, "x.a", { version: "1", package: "x.p", path: ".", integrity: `sha256-${"a".repeat(64)}`, trusted: false }), "legacy-lock", "capability row into v1");
  // The legacy v1 writer, conversely, never downgrades or rewrites a current lock.
  const cur = scope(t, "cur");
  writePackageLock(cur, "x.p", { source: "path:/d", path: ".", version: "1", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] });
  throwsCode(() => writeCapabilityLock(cur, "x.a", { source: "marketplace:x.a@1", version: "1", integrity: `sha256-${"a".repeat(64)}` }), "legacy-lock", "v1 entry into a current lock");
  assert.equal(lockOf(cur).lockfileVersion, 2);
});

test("prototype-named package and capability IDs cannot forge providers, dependencies or trust", () => {
  const t = temp();
  const s = scope(t);
  const row = { source: "path:/tmp/x", path: ".", version: "1", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] };
  // A raw-JSON __proto__ / constructor key must never read back as a real entry.
  write(join(s, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 2,
    packages: { "x.p": row },
    capabilities: { "x.a": { version: "1", package: "x.p", path: ".", integrity: `sha256-${"b".repeat(64)}`, trusted: true } },
  }));
  const read = readPackageLocks(s);
  for (const hostile of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.equal(read.packages[hostile], undefined, `packages[${hostile}] must not resolve through the prototype`);
    assert.equal(read.capabilities[hostile], undefined, `capabilities[${hostile}] must not resolve through the prototype`);
  }
  // A dependency literally named "constructor" is not satisfied by Object.prototype.
  throwsCode(() => validateLockEntry("x.p", { ...row, dependencies: ["constructor"] }, { "x.p": row }), "invalid-lock", "prototype-named dependency");
  // A capability row naming a prototype-named provider is dangling, not valid.
  throwsCode(() => validateCapabilityLockEntry("x.a", { version: "1", package: "constructor", path: ".", integrity: `sha256-${"b".repeat(64)}`, trusted: false }, { "x.p": row }), "invalid-lock", "prototype-named provider");
  // Prototype-named IDs in the raw document are rejected as invalid keys, not accepted.
  const hostile = scope(t, "hostile");
  write(join(hostile, OAS_LOCK_FILE), `{"lockfileVersion":2,"packages":{"__proto__":${JSON.stringify(row)}},"capabilities":{}}`);
  throwsCode(() => parseLockFileStrict(join(hostile, OAS_LOCK_FILE)), "invalid-lock", "a JSON __proto__ package key");
});

test("readPackageLocks: closest scope wins, lock-only scopes are visible, invalid locks RAISE", () => {
  const t = temp();
  const outer = scope(t, "outer");
  const row = (v) => ({ source: "path:/tmp/x", path: ".", version: v, commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] });
  writePackageLock(outer, "x.p", row("1.0.0"));
  // A NESTED scope owning only a lock (no oas-config.yaml) must still be seen.
  const inner = join(outer, "inner");
  mkdirSync(inner, { recursive: true });
  writePackageLock(inner, "x.p", row("2.0.0"));
  assert.equal(readPackageLocks(inner).packages["x.p"].version, "2.0.0", "closest scope wins");
  assert.equal(readPackageLocks(outer).packages["x.p"].version, "1.0.0");
  write(join(inner, OAS_LOCK_FILE), "{ not json");
  throwsCode(() => readPackageLocks(inner), "invalid-lock", "malformed inner lock");
});

// ---------- acquisition and projection ----------

test("acquirePackage: materializes flat self-contained artifacts, locks both levels, activates and trusts nothing", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p", configTemplates: { default: { path: "config-templates/default/oas-config.yaml", default: true } } }, {
    "capabilities/a": { capability: "x.a", version: "2.1.0", skills: ["skills/s"], commands: { go: "bin/go.mjs run" } },
    "capabilities/b": { capability: "x.b", version: "3.0.0" },
  });
  write(join(src, "capabilities/a/skills/s/SKILL.md"), "# s\n");
  write(join(src, "capabilities/a/bin/go.mjs"), "//\n");
  write(join(src, "config-templates/default/oas-config.yaml"), "name: demo\n");
  const s = scope(t);
  const r = acquirePackage(s, src);

  assert.equal(r.root, "x.p");
  assert.deepEqual(r.capabilities.map((c) => c.capability).sort(), ["x.a", "x.b"]);
  assert.deepEqual(r.capabilities.map((c) => c.status), ["installed", "installed"]);
  assert.ok(r.capabilities.every((c) => c.trusted === false), "acquisition trusts nothing");
  assert.deepEqual(r.installed[0].dependencies, []);

  // Flat artifacts, self-contained, with the capability's own resources.
  assert.ok(existsSync(join(artifact(s, "x.a"), "skills/s/SKILL.md")));
  assert.ok(existsSync(join(artifact(s, "x.b"), "oas.json")));
  assert.equal(existsSync(join(artifact(s, "x.a"), "oas-package.json")), false, "a dedicated capability root carries no package manifest");

  // No persistent package root anywhere, and no staging left behind.
  assert.equal(existsSync(join(s, ".agents", "packages")), false, "no package store exists in this model");
  assert.deepEqual(readdirSync(join(s, ".agents/capabilities/installed")).sort(), ["x.a", "x.b"], "staging discarded");

  // The lock records both levels; package rows are transport-only.
  const doc = lockOf(s);
  assert.deepEqual(Object.keys(doc.packages), ["x.p"]);
  assert.deepEqual(Object.keys(doc.packages["x.p"]).sort(), ["commit", "dependencies", "integrity", "path", "source", "version"]);
  assert.equal(doc.capabilities["x.a"].version, "2.1.0", "capability version is its OWN, not the package's");
  assert.equal(doc.capabilities["x.a"].package, "x.p");
  assert.equal(doc.capabilities["x.a"].path, "capabilities/a");
  assert.equal(doc.capabilities["x.a"].trusted, false);

  // Config templates come back with descriptors AND bytes, applied to nothing.
  assert.equal(r.configTemplates.length, 1);
  assert.equal(r.configTemplates[0].content, "name: demo\n");
  assert.match(r.configTemplates[0].contentIntegrity, /^sha256-[0-9a-f]{64}$/);
  assert.equal(r.configTemplates[0].default, true);
  assert.equal(readFileSync(join(s, "oas-config.yaml"), "utf8"), "name: test\n", "install applies no template");

  // Acquired is not active.
  assert.deepEqual(activeIds(s), [], "nothing activated");
});

test("acquirePackage: dependency closure, cycles, identity collisions, unpinned git dependency", () => {
  const t = temp();
  const dep = pkgSource(join(t, "dep"), { package: "x.dep" }, { "capabilities/d": { capability: "x.d" } });
  const root = pkgSource(join(t, "root"), { package: "x.root", dependencies: [dep] }, { "capabilities/r": { capability: "x.r" } });
  const s = scope(t);
  const r = acquirePackage(s, root);
  assert.deepEqual(r.installed.map((p) => p.package).sort(), ["x.dep", "x.root"]);
  assert.deepEqual(lockOf(s).packages["x.root"].dependencies, ["x.dep"]);
  assert.deepEqual(Object.keys(lockOf(s).capabilities).sort(), ["x.d", "x.r"]);

  // Cycle.
  const t2 = temp();
  const a = join(t2, "a"), b = join(t2, "b");
  pkgSource(a, { package: "c.a", dependencies: [b] }, { "capabilities/a": { capability: "c.acap" } });
  pkgSource(b, { package: "c.b", dependencies: [a] }, { "capabilities/b": { capability: "c.bcap" } });
  const cyc = throwsCode(() => acquirePackage(scope(t2), a), "dependency-cycle", "cycle");
  assert.ok(cyc.provenance.length >= 2);

  // Two sources claiming one identity.
  const t3 = temp();
  const one = pkgSource(join(t3, "one"), { package: "c.same" }, { "capabilities/a": { capability: "c.one" } });
  const two = pkgSource(join(t3, "two"), { package: "c.same" }, { "capabilities/b": { capability: "c.two" } });
  const wrap = pkgSource(join(t3, "wrap"), { package: "c.wrap", dependencies: [one, two] }, { "capabilities/w": { capability: "c.w" } });
  throwsCode(() => acquirePackage(scope(t3), wrap), "duplicate-package-identity", "same identity twice");

  // Unpinned git dependency.
  const t4 = temp();
  const gp = pkgSource(join(t4, "gitpkg"), { package: "c.g" }, { "capabilities/g": { capability: "c.gcap" } });
  gitify(gp);
  const parent = pkgSource(join(t4, "parent"), { package: "c.parent", dependencies: [`file://${gp}`] }, { "capabilities/p": { capability: "c.p" } });
  throwsCode(() => acquirePackage(scope(t4), parent), "invalid-source", "unpinned git dependency");
});

test("acquirePackage: two packages at one scope cannot export the same capability ID", () => {
  const t = temp();
  const s = scope(t);
  acquirePackage(s, pkgSource(join(t, "p1"), { package: "x.one" }, { "capabilities/a": { capability: "shared.cap" } }));
  const e = throwsCode(() => acquirePackage(s, pkgSource(join(t, "p2"), { package: "x.two" }, { "capabilities/a": { capability: "shared.cap" } })), "duplicate-capability-id", "cross-package collision");
  assert.deepEqual(e.provenance.sort(), ["x.one", "x.two"]);
  // The refused acquisition changed nothing.
  assert.deepEqual(Object.keys(lockOf(s).packages), ["x.one"]);
  assert.equal(lockOf(s).capabilities["shared.cap"].package, "x.one");
});

test("acquirePackage: a locked source never advances on acquire — integrity and selected path both", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  const s = scope(t);
  acquirePackage(s, src);
  const before = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  write(join(src, "capabilities/a/extra.md"), "drifted\n");
  throwsCode(() => acquirePackage(s, src), "integrity-drift", "changed source on re-acquire");
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), before, "lock unchanged");
});

test("acquirePackage: incompatible compatibility.oas floor is rejected before anything is written", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p", compatibility: { oas: ">=999.0.0" } }, { "capabilities/a": { capability: "x.a" } });
  const s = scope(t);
  throwsCode(() => acquirePackage(s, src), "incompatible-oas", "floor");
  assert.equal(existsSync(join(s, OAS_LOCK_FILE)), false);
});

test("acquirePackage: a v1 lock at the scope blocks package install with legacy-lock and changes nothing", () => {
  const t = temp();
  const s = scope(t);
  const v1 = { lockfileVersion: 1, capabilities: { "old.cap": { source: "marketplace:old.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` } } };
  write(join(s, OAS_LOCK_FILE), JSON.stringify(v1, null, 2));
  const before = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  const e = throwsCode(() => acquirePackage(s, src), "legacy-lock", "v1 scope");
  assert.match(e.message, /oas migrate/);
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), before);
  assert.equal(existsSync(artifact(s, "x.a")), false);
});

test("an EMPTY v1 scope is refused too, and refused BEFORE the source is ever fetched", () => {
  const t = temp();
  const s = scope(t);
  gitify(s);
  write(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: {} }, null, 2));
  const lockBefore = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  // A source that CANNOT be fetched: reaching the fetch would raise
  // invalid-source, so `legacy-lock` proves the preflight ran first.
  const missing = join(t, "no-such-source");
  assert.equal(existsSync(missing), false);
  const e = throwsCode(() => acquirePackage(s, missing), "legacy-lock", "empty v1 scope");
  assert.match(e.message, /oas migrate/);
  // An empty v1 is an UNCONVERTED scope, not an absent lock: install must never
  // convert it as a side effect, and `lockDraft` refuses it identically.
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore, "lock bytes untouched — never converted implicitly");
  assert.equal(existsSync(join(s, ".agents/capabilities/installed")), false, "no store, no staging");
  assert.equal(existsSync(join(s, ".agents/capabilities/.gitignore")), false, "no ignore file was written");
  // And a fetchable source is refused identically — the refusal is about the
  // scope, not about the spec.
  const repo = pkgSource(join(t, "repo", "oas-package"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  const commit = gitify(join(t, "repo"));
  throwsCode(() => acquirePackage(s, `file://${join(t, "repo")}@${commit}#oas-package`), "legacy-lock", "empty v1, valid source");
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore);
  assert.equal(existsSync(join(s, ".agents/capabilities/installed")), false);
  assert.ok(existsSync(join(repo, "oas-package.json")), "the source itself is untouched");
  // The whole point of refusing: explicit migration is still the only way in.
  applyLegacyLockMigration(s);
  assert.equal(lockOf(s).lockfileVersion, 2);
  acquirePackage(s, `file://${join(t, "repo")}@${commit}#oas-package`);
  assert.ok(existsSync(artifact(s, "x.a")));
});

test("acquirePackage: catalog is identity/discovery only — resolution grants no trust and advances no lock", () => {
  const t = temp();
  const repo = pkgSource(join(t, "repo", "oas-package"), { package: "x.official" }, { "capabilities/a": { capability: "x.a", commands: { go: "bin/go.mjs run" } } });
  write(join(repo, "capabilities/a/bin/go.mjs"), "//\n");
  const commit = gitify(join(t, "repo"));
  const catalog = (id) => (id === "x.official" ? { url: `file://${join(t, "repo")}`, ref: commit, path: "oas-package" } : undefined);
  const s = scope(t);
  const r = acquirePackage(s, "x.official", { catalog });
  assert.equal(lockOf(s).packages["x.official"].source, "catalog:x.official", "a bare request locks the bare form");
  assert.equal(lockOf(s).packages["x.official"].commit, commit, "the resolved commit is pinned separately");
  assert.equal(lockOf(s).packages["x.official"].path, "oas-package", "the catalog entry's path is honoured");
  assert.equal(r.capabilities[0].trusted, false, "official identity is not executable approval");
  // An explicit selector round-trips distinguishably.
  const s2 = scope(t, "scope2");
  acquirePackage(s2, `x.official@${commit}`, { catalog });
  assert.equal(lockOf(s2).packages["x.official"].source, `catalog:x.official@${commit}`);
});

test("acquirePackage: the selected package root is what gets staged and hashed — siblings never reach the artifact", () => {
  const t = temp();
  const repoRoot = join(t, "repo");
  write(join(repoRoot, "README.md"), "repo docs — must never install\n");
  write(join(repoRoot, "other-package/oas-package.json"), "{}");
  pkgSource(join(repoRoot, "dist/oas"), { package: "x.contained" }, { "capabilities/a": { capability: "x.a" } });
  const commit = gitify(repoRoot);
  const s = scope(t);
  acquirePackage(s, `file://${repoRoot}@${commit}#dist/oas`);
  assert.equal(lockOf(s).packages["x.contained"].path, "dist/oas");
  assert.equal(existsSync(join(artifact(s, "x.a"), "README.md")), false);
  assert.ok(existsSync(join(artifact(s, "x.a"), "oas.json")));
});

// ---------- artifact provenance ----------

test(".oas-installation.json is deterministic, lock-derived, and reproducible under a different kernel", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a", version: "2.1.0" } });
  const s = scope(t);
  acquirePackage(s, src);
  const file = join(artifact(s, "x.a"), CAPABILITY_INSTALLATION_FILE);
  const raw = readFileSync(file, "utf8");
  const doc = JSON.parse(raw);
  // Exactly these keys, in this order — nothing about the writing kernel, so a
  // newer kernel reprojecting the same locked bytes reproduces the same hash.
  assert.deepEqual(Object.keys(doc), ["schemaVersion", "capability", "version", "package", "packageVersion", "source", "commit", "packagePath", "capabilityPath"]);
  assert.equal(doc.schemaVersion, 1);
  assert.ok(!("installedBy" in doc), "no volatile writer version");
  assert.equal(raw, JSON.stringify(doc, null, 2) + "\n", "two-space JSON with one trailing newline");
  assert.equal(lstatSync(file).mode & 0o777, 0o644);
  // Field agreement with the lock rows.
  const lock = lockOf(s);
  assert.equal(doc.version, lock.capabilities["x.a"].version);
  assert.equal(doc.capabilityPath, lock.capabilities["x.a"].path);
  assert.equal(doc.commit, lock.packages["x.p"].commit);

  // A second projection of the same locked bytes is byte-identical.
  const integrity = lock.capabilities["x.a"].integrity;
  rmSync(artifact(s, "x.a"), { recursive: true, force: true });
  const rep = restorePackages(s);
  assert.equal(rep.find((x) => x.capability === "x.a").status, "restored");
  assert.equal(capabilityArtifactIntegrity(artifact(s, "x.a")), integrity, "reprojection reproduces the artifact hash exactly");
  assert.equal(readFileSync(file, "utf8"), raw);
});

test("tampering with provenance is integrity drift and revokes trust", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a", commands: { go: "bin/go.mjs run" } } });
  write(join(src, "capabilities/a/bin/go.mjs"), "//\n");
  const s = scope(t, "scope", "name: test\ncapabilities:\n  additive:\n    x.a:\n      global: true\n");
  acquirePackage(s, src);
  approveCapability(s, "x.a");
  assert.equal(capabilityTrust(s, "x.a").trusted, true);
  const file = join(artifact(s, "x.a"), CAPABILITY_INSTALLATION_FILE);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...doc, package: "someone.else" }, null, 2) + "\n");
  const trust = capabilityTrust(s, "x.a");
  assert.equal(trust.trusted, false, "provenance is inside the hashed tree");
  assert.match(trust.reason, /integrity/i);
});

// ---------- restore ----------

test("restorePackages: ok when present, reprojects when missing, refuses drift, never advances", () => {
  const t = temp();
  const repo = pkgSource(join(t, "repo", "oas-package"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  const commit = gitify(join(t, "repo"));
  const s = scope(t);
  acquirePackage(s, `file://${join(t, "repo")}@${commit}#oas-package`);
  const locked = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));

  assert.equal(restorePackages(s)[0].status, "ok", "present + matching = ok");

  rmSync(artifact(s, "x.a"), { recursive: true, force: true });
  assert.equal(restorePackages(s).find((r) => r.capability === "x.a").status, "restored");
  assert.deepEqual(JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8")), locked, "restore never advances the lock");

  // The upstream moves on: bare restore stays at the locked commit.
  write(join(repo, "capabilities/a/new.md"), "moved on\n");
  gitCommit(join(t, "repo"));
  rmSync(artifact(s, "x.a"), { recursive: true, force: true });
  restorePackages(s);
  assert.equal(existsSync(join(artifact(s, "x.a"), "new.md")), false, "the exact locked commit is restored");

  // Payload drift at the locked commit is refused.
  const s2 = scope(t, "scope2");
  const localSrc = pkgSource(join(t, "local"), { package: "x.local" }, { "capabilities/a": { capability: "x.localcap" } });
  acquirePackage(s2, localSrc);
  rmSync(artifact(s2, "x.localcap"), { recursive: true, force: true });
  write(join(localSrc, "capabilities/a/drift.md"), "drift\n");
  const failed = restorePackages(s2).find((r) => r.capability === "x.localcap");
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, "integrity-drift");
  assert.equal(existsSync(artifact(s2, "x.localcap")), false, "a failed restore installs nothing");
});

test("restorePackages: a provider that no longer exports the locked capability at the locked path fails closed", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  const s = scope(t);
  acquirePackage(s, src);
  // Forge a capability row pointing at a path the package does not export.
  const doc = lockOf(s);
  doc.capabilities["x.a"].path = "capabilities/moved";
  write(join(s, OAS_LOCK_FILE), JSON.stringify(doc, null, 2));
  rmSync(artifact(s, "x.a"), { recursive: true, force: true });
  const r = restorePackages(s).find((x) => x.capability === "x.a");
  assert.equal(r.status, "failed");
  assert.equal(r.code, "capability-list-mismatch");
});

test("restore preflight covers the COMPLETE visible chain before any mutation", () => {
  const t = temp();
  const outer = scope(t, "outer");
  acquirePackage(outer, pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } }));
  rmSync(artifact(outer, "x.a"), { recursive: true, force: true });
  // A malformed INNER lock-only scope must fail before the outer artifact is touched.
  const inner = join(outer, "inner");
  mkdirSync(inner, { recursive: true });
  write(join(inner, OAS_LOCK_FILE), "{ not json");
  throwsCode(() => restorePackages(inner), "invalid-lock", "malformed inner lock");
  assert.equal(existsSync(artifact(outer, "x.a")), false, "the outer artifact was never restored");
});

test("restorePackages reports an unconverted v1 scope as legacy with its migration action", () => {
  const t = temp();
  const s = scope(t);
  write(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: {} }));
  const r = restorePackages(s);
  assert.equal(r[0].status, "legacy");
  assert.equal(r[0].lockfileVersion, 1);
  assert.match(r[0].reason, /oas migrate/);
});

// ---------- discovery, activation, trust ----------

test("discovery: materialized capabilities are addressable with from: installed; owned keeps precedence", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  const s = scope(t, "scope", "name: t\ncapabilities:\n  additive:\n    x.a:\n      global: true\n      from: installed\n");
  acquirePackage(s, src);
  const m = capabilityManifest("x.a", s);
  assert.equal(m._package, "x.p", "provenance comes from the lock, not a package directory");
  assert.equal(m._dir, artifact(s, "x.a"));
  assert.deepEqual(activeIds(s), ["x.a"], "explicit activation works");

  // owned/ wins over installed at the same scope.
  write(join(s, ".agents/capabilities/owned/x.a/oas.json"), JSON.stringify({ capability: "x.a", version: "9.9.9", description: "owned" }));
  assert.equal(capabilityManifest("x.a", s).version, "9.9.9");
});

test("discovery skips transaction staging directories", () => {
  const t = temp();
  const s = scope(t);
  acquirePackage(s, pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } }));
  // Simulate a staging directory left by a crashed process.
  const stale = join(s, ".agents/capabilities/installed/.staging-abc");
  write(join(stale, "oas.json"), JSON.stringify({ capability: "ghost.cap", version: "1.0.0", description: "d" }));
  assert.deepEqual(Object.keys(capabilityManifests(s)), ["x.a"], "dot-prefixed entries are never installed content");
});

test("trust binds to the capability ARTIFACT integrity: approval, drift invalidation, non-executable no-op", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, {
    "capabilities/a": { capability: "x.exec", commands: { go: "bin/go.mjs run" }, hooks: { spawn: "bin/hook.mjs spawn" } },
    "capabilities/b": { capability: "x.plain" },
  });
  write(join(src, "capabilities/a/bin/go.mjs"), "//\n");
  write(join(src, "capabilities/a/bin/hook.mjs"), "//\n");
  const s = scope(t);
  acquirePackage(s, src);

  // Instruction-only capabilities need no approval.
  assert.equal(capabilityTrust(s, "x.plain").trusted, true);
  // Executable surfaces do.
  const untrusted = capabilityTrust(s, "x.exec");
  assert.equal(untrusted.trusted, false);
  assert.match(untrusted.reason, /oas trust x\.exec/);
  assert.deepEqual(untrusted.executableSurface, { commands: ["go"], hooks: ["spawn"] });

  const approved = approveCapability(s, "x.exec");
  assert.deepEqual(approved.approved, ["x.exec"]);
  assert.equal(lockOf(s).capabilities["x.exec"].trusted, true);
  assert.equal(lockOf(s).capabilities["x.plain"].trusted, false, "approving one capability never touches another");
  assert.equal(capabilityTrust(s, "x.exec").trusted, true);

  // Tampering with the artifact — including its materialized closure — revokes it.
  write(join(artifact(s, "x.exec"), "bin/evil.mjs"), "//\n");
  assert.equal(capabilityTrust(s, "x.exec").trusted, false);
  throwsCode(() => approveCapability(s, "x.exec"), "integrity-drift", "approving a drifted artifact");

  // Bulk approval is per PACKAGE and skips non-executable capabilities.
  const s2 = scope(t, "scope2");
  acquirePackage(s2, src);
  const bulk = approveCapability(s2, "x.p", { allCapabilities: true });
  assert.deepEqual(bulk.approved, ["x.exec"]);
  assert.deepEqual(bulk.skipped, ["x.plain"]);
  throwsCode(() => approveCapability(s2, "nope.cap"), "unknown-capability", "unknown target");
});

test("trust queries RAISE on an invalid lock — a bad lock is never served as untrusted-but-fine", () => {
  const t = temp();
  const s = scope(t);
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a", commands: { go: "bin/go.mjs run" } } });
  write(join(src, "capabilities/a/bin/go.mjs"), "//\n");
  acquirePackage(s, src);
  const doc = lockOf(s);
  doc.capabilities["x.a"].trusted = "yes";
  write(join(s, OAS_LOCK_FILE), JSON.stringify(doc, null, 2));
  throwsCode(() => capabilityTrust(s, "x.a"), "invalid-lock", "malformed trusted flag");
});

// ---------- update and remove ----------

test("updatePackage: replaces every export atomically; unchanged capabilities keep trust, changed ones lose it", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, {
    "capabilities/a": { capability: "x.changed", commands: { go: "bin/go.mjs run" } },
    "capabilities/b": { capability: "x.stable", commands: { go: "bin/go.mjs run" } },
  });
  write(join(src, "capabilities/a/bin/go.mjs"), "//\n");
  write(join(src, "capabilities/b/bin/go.mjs"), "//\n");
  const s = scope(t);
  acquirePackage(s, src);
  approveCapability(s, "x.changed");
  approveCapability(s, "x.stable");

  write(join(src, "capabilities/a/new.md"), "changed\n");
  const r = updatePackage(s, "x.p");
  assert.equal(r.changed, true);
  assert.equal(lockOf(s).capabilities["x.changed"].trusted, false, "a changed artifact loses approval");
  assert.equal(lockOf(s).capabilities["x.stable"].trusted, true, "trust is per capability, so an untouched export keeps it");
  assert.deepEqual(r.invalidatedApprovals, ["x.changed"]);
  assert.ok(existsSync(join(artifact(s, "x.changed"), "new.md")));

  // A true no-op update reports unchanged.
  assert.equal(updatePackage(s, "x.p").changed, false);
});

test("updatePackage: a removed export is retired only when no config references it", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.keep" }, "capabilities/b": { capability: "x.going" } });
  const s = scope(t, "scope", "name: t\ncapabilities:\n  additive:\n    x.going:\n      global: true\n");
  acquirePackage(s, src);
  const lockBefore = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const goingBefore = capabilityArtifactIntegrity(artifact(s, "x.going"));
  // Drop the export while config still references it.
  rmSync(join(src, "capabilities/b"), { recursive: true, force: true });
  write(join(src, "oas-package.json"), JSON.stringify({ package: "x.p", version: "2.0.0", description: "pkg", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"] }, null, 2));
  throwsCode(() => updatePackage(s, "x.p"), "remove-blocked", "config still references the dropped export");
  // The refusal is a PRE-COMMIT gate, so the pre-operation state is not
  // "restored" — it was never touched. Re-acquiring the old version could not
  // achieve this: the source it would re-acquire from has itself moved on.
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore, "lock bytes untouched");
  assert.equal(capabilityArtifactIntegrity(artifact(s, "x.going")), goingBefore, "the dropped export's artifact is neither orphaned nor removed");

  // Once the reference is gone, the artifact is retired.
  write(join(s, "oas-config.yaml"), "name: t\n");
  const r = updatePackage(s, "x.p");
  assert.deepEqual(r.removedCapabilities, ["x.going"]);
  assert.equal(existsSync(artifact(s, "x.going")), false);
  assert.equal(lockOf(s).capabilities["x.going"], undefined);
  assert.ok(lockOf(s).capabilities["x.keep"]);
});

test("updatePackage: an identity change fails PRE-COMMIT — nothing lands under the new identity", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  const s = scope(t);
  acquirePackage(s, src);
  write(join(src, "oas-package.json"), JSON.stringify({ package: "x.renamed", version: "2.0.0", description: "pkg", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"] }, null, 2));
  throwsCode(() => updatePackage(s, "x.p"), "duplicate-package-identity", "renamed source");
  assert.deepEqual(Object.keys(lockOf(s).packages), ["x.p"]);
  assert.equal(existsSync(join(s, ".agents/capabilities/installed/x.renamed")), false);
});

test("removePackage: refuses while a dependent package or a config reference exists, then removes cleanly", () => {
  const t = temp();
  const dep = pkgSource(join(t, "dep"), { package: "x.dep" }, { "capabilities/d": { capability: "x.d" } });
  const root = pkgSource(join(t, "root"), { package: "x.root", dependencies: [dep] }, { "capabilities/r": { capability: "x.r" } });
  const s = scope(t, "scope", "name: t\ncapabilities:\n  additive:\n    x.r:\n      global: true\n");
  acquirePackage(s, root);

  const blockedByDependent = throwsCode(() => removePackage(s, "x.dep"), "remove-blocked", "dependent package");
  assert.match(blockedByDependent.message, /x\.root/);
  const blockedByConfig = throwsCode(() => removePackage(s, "x.root"), "remove-blocked", "config reference");
  assert.match(blockedByConfig.message, /x\.r/);

  write(join(s, "oas-config.yaml"), "name: t\n");
  const r = removePackage(s, "x.root");
  assert.deepEqual(r.capabilities, ["x.r"]);
  assert.equal(existsSync(artifact(s, "x.r")), false);
  assert.equal(lockOf(s).packages["x.root"], undefined);
  assert.equal(lockOf(s).capabilities["x.r"], undefined);
  assert.ok(lockOf(s).packages["x.dep"], "unrelated packages are untouched");
  assert.ok(existsSync(artifact(s, "x.d")));
  removePackage(s, "x.dep"); // now unblocked
  assert.deepEqual(lockOf(s), { lockfileVersion: 2, packages: {}, capabilities: {} });
});

// ---------- config templates ----------

test("readLockedConfigTemplates: exact locked bytes, no persisted package root, typed unknown template", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p", configTemplates: { default: { path: "c/default.yaml", default: true, description: "recommended" }, minimal: { path: "c/minimal.yaml" } } }, { "capabilities/a": { capability: "x.a" } });
  write(join(src, "c/default.yaml"), "name: full\n");
  write(join(src, "c/minimal.yaml"), "name: minimal\n");
  const s = scope(t);
  const acq = acquirePackage(s, src);

  const all = readLockedConfigTemplates(s, "x.p");
  assert.deepEqual(all.templates.map((x) => x.template).sort(), ["default", "minimal"]);
  assert.equal(all.integrity, lockOf(s).packages["x.p"].integrity, "the payload integrity is verified against the lock");
  assert.equal(all.commit, "local");
  const one = readLockedConfigTemplates(s, "x.p", { template: "default" });
  assert.equal(one.templates[0].content, "name: full\n");
  assert.equal(one.templates[0].description, "recommended");
  assert.equal(one.templates[0].default, true);
  // The digest matches what acquisition already handed the config lane.
  const inline = acq.configTemplates.find((x) => x.template === "default");
  assert.equal(inline.contentIntegrity, one.templates[0].contentIntegrity, "same bytes, same digest, no second fetch needed");

  throwsCode(() => readLockedConfigTemplates(s, "x.p", { template: "nope" }), "unknown-config-template", "unknown template");
  throwsCode(() => readLockedConfigTemplates(s, "not.locked"), "unknown-capability", "unlocked package");
  // Nothing persisted, nothing mutated.
  assert.equal(existsSync(join(s, ".agents", "packages")), false);
  assert.deepEqual(readdirSync(join(s, ".agents/capabilities/installed")), ["x.a"]);
});

test("both template readers produce ONE descriptor shape — legacySpelling sits on every item, canonical and legacy alike", () => {
  const t = temp();
  // Canonical spelling.
  const modern = pkgSource(join(t, "modern"), { package: "x.modern", configTemplates: { default: { path: "c/d.yaml", default: true, description: "recommended" }, minimal: { path: "c/m.yaml" } } }, { "capabilities/a": { capability: "x.a" } });
  write(join(modern, "c/d.yaml"), "name: full\n");
  write(join(modern, "c/m.yaml"), "name: minimal\n");
  const s = scope(t);
  const acq = acquirePackage(s, modern);
  const locked = readLockedConfigTemplates(s, "x.modern");
  const KEYS = ["content", "contentIntegrity", "default", "legacySpelling", "path", "template"]; // sorted
  for (const item of locked.templates) {
    assert.equal(Object.hasOwn(item, "legacySpelling"), true, `${item.template}: legacySpelling is per-descriptor, not root-only`);
    assert.equal(item.legacySpelling, false);
  }
  assert.equal(locked.legacySpelling, false, "the root value stays available as a package-level convenience");
  // Field-for-field agreement between the two readers: acquisition's descriptor
  // is the locked reader's plus `package`. A consumer must never need to know
  // which reader produced a descriptor.
  for (const item of locked.templates) {
    const staged = acq.configTemplates.find((x) => x.template === item.template);
    assert.deepEqual(Object.keys(staged).sort(), ["package", ...Object.keys(item)].sort(), `${item.template}: same fields`);
    assert.deepEqual({ ...staged, package: undefined }, { ...item, package: undefined }, `${item.template}: same values`);
  }
  assert.deepEqual(Object.keys(locked.templates.find((x) => x.template === "default")).sort(), [...KEYS, "description"].sort());
  assert.deepEqual(Object.keys(locked.templates.find((x) => x.template === "minimal")).sort(), KEYS, "an absent description is absent, not undefined");

  // Legacy spelling: same shape, flag flipped, on every item.
  const d = join(t, "legacy");
  write(join(d, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.l", version: "1.0.0", description: "d" }));
  write(join(d, "configs/default/oas-config.yaml"), "name: legacy\n");
  write(join(d, "oas-package.json"), JSON.stringify({ package: "x.legacy", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"], configs: { default: { path: "configs/default/oas-config.yaml", default: true } } }));
  const s2 = scope(t, "scope2");
  const acq2 = acquirePackage(s2, d);
  const locked2 = readLockedConfigTemplates(s2, "x.legacy");
  assert.equal(locked2.templates[0].legacySpelling, true);
  assert.equal(acq2.configTemplates[0].legacySpelling, true);
  assert.deepEqual(Object.keys(locked2.templates[0]).sort(), KEYS);
});

test("contentIntegrity digests the EXACT file bytes, and undecodable template bytes fail closed", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p", configTemplates: { default: { path: "c/d.yaml", default: true } } }, { "capabilities/a": { capability: "x.a" } });
  // Bytes chosen so a lossy read would differ from the file: a lone CR, a BOM,
  // a NUL and a multi-byte character all survive an exact-byte digest.
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xc3, 0xa9, 0x00, 0x0d, 0x0a]);
  write(join(src, "c/d.yaml"), "");
  writeFileSync(join(src, "c/d.yaml"), bytes);
  const expected = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
  const s = scope(t);
  const acq = acquirePackage(s, src);
  const locked = readLockedConfigTemplates(s, "x.p");
  assert.equal(acq.configTemplates[0].contentIntegrity, expected, "acquisition digests the file bytes");
  assert.equal(locked.templates[0].contentIntegrity, expected, "the locked reader agrees, byte for byte");
  // The digest must reproduce from the bytes an adopter would write back.
  assert.equal(`sha256-${createHash("sha256").update(Buffer.from(locked.templates[0].content, "utf8")).digest("hex")}`, expected, "content round-trips to the same bytes");

  // Invalid UTF-8 is a malformed package, never silently repaired to U+FFFD —
  // a replacement-character digest is one nothing can reproduce from the file.
  const bad = pkgSource(join(t, "bad"), { package: "x.bad", configTemplates: { default: { path: "c/d.yaml" } } }, { "capabilities/a": { capability: "x.badcap" } });
  write(join(bad, "c/d.yaml"), "");
  writeFileSync(join(bad, "c/d.yaml"), Buffer.from([0x6e, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));
  const s2 = scope(t, "scope2");
  const e = throwsCode(() => acquirePackage(s2, bad), "invalid-package-manifest", "invalid UTF-8 template");
  assert.match(e.message, /UTF-8/);
  assert.equal(existsSync(join(s2, OAS_LOCK_FILE)), false, "the package never installed");
  assert.equal(existsSync(artifact(s2, "x.badcap")), false);
});

test("readLockedConfigTemplates normalizes the deprecated configs spelling and flags it", () => {
  const t = temp();
  const d = join(t, "legacy");
  write(join(d, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.a", version: "1.0.0", description: "d" }));
  write(join(d, "configs/default/oas-config.yaml"), "name: legacy\n");
  write(join(d, "oas-package.json"), JSON.stringify({ package: "x.legacy", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"], configs: { default: { path: "configs/default/oas-config.yaml", default: true } } }));
  const s = scope(t);
  acquirePackage(s, d);
  const r = readLockedConfigTemplates(s, "x.legacy");
  assert.equal(r.legacySpelling, true);
  assert.equal(r.templates[0].content, "name: legacy\n");
});

// ---------- gitignore ----------

test("the installed-store gitignore is ensured transactionally, ignores installed/ ONLY, and no-ops outside Git", () => {
  const t = temp();
  const s = scope(t);
  gitify(s);
  acquirePackage(s, pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } }));
  const ignore = readFileSync(join(s, ".agents/capabilities/.gitignore"), "utf8");
  assert.match(ignore, /^installed\/$/m);
  assert.ok(!/owned/.test(ignore), "authored capabilities are meant to be committed");
  assert.ok(!/config-templates/.test(ignore), "adopted template bases are meant to be committed");
  // Git agrees: the artifact is ignored, owned/ and adopted data are not.
  write(join(s, ".agents/capabilities/owned/y/oas.json"), "{}");
  write(join(s, ".agents/config-templates/adopted/x.p/default/adoption.json"), "{}");
  const status = execFileSync("git", ["-C", s, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  assert.ok(!status.includes("installed/x.a"), "generated artifacts cannot enter a commit");
  assert.ok(status.includes("owned/y/oas.json"));
  assert.ok(status.includes("adopted/x.p/default/adoption.json"));

  // A non-Git scope works without any fake Git state.
  const plain = scope(t, "plain");
  assert.equal(ensureInstalledGitignore(plain), false);
  acquirePackage(plain, pkgSource(join(t, "src2"), { package: "x.q" }, { "capabilities/a": { capability: "x.q1" } }));
  assert.equal(existsSync(join(plain, ".agents/capabilities/.gitignore")), false);
  assert.ok(existsSync(artifact(plain, "x.q1")));
});

// ---------- transaction guarantees ----------

test("a failed transaction leaves store, lock and ignore bytes byte-identical", () => {
  const t = temp();
  const s = scope(t);
  gitify(s);
  const good = pkgSource(join(t, "good"), { package: "x.good" }, { "capabilities/a": { capability: "x.a" } });
  acquirePackage(s, good);
  const lockBefore = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const ignoreBefore = readFileSync(join(s, ".agents/capabilities/.gitignore"), "utf8");
  const artifactBefore = capabilityArtifactIntegrity(artifact(s, "x.a"));

  // A closure whose second package is broken: everything must roll back.
  const brokenDep = join(t, "broken");
  write(join(brokenDep, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.b", version: "1.0.0", description: "d", skills: ["missing-skill"] }));
  write(join(brokenDep, "oas-package.json"), JSON.stringify({ package: "x.broken", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"] }));
  throwsCode(() => acquirePackage(s, brokenDep), "capability-not-self-contained", "missing declared skill");

  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore);
  assert.equal(readFileSync(join(s, ".agents/capabilities/.gitignore"), "utf8"), ignoreBefore);
  assert.equal(capabilityArtifactIntegrity(artifact(s, "x.a")), artifactBefore);
  assert.equal(existsSync(artifact(s, "x.b")), false);
  assert.deepEqual(readdirSync(join(s, ".agents/capabilities/installed")), ["x.a"], "staging removed");
});

test("assertCommittable sees the COMPLETE staged plan — template bytes included — and a throw mutates nothing", () => {
  const t = temp();
  const dep = pkgSource(join(t, "dep"), { package: "x.dep" }, { "capabilities/d": { capability: "x.d" } });
  const src = pkgSource(join(t, "src"), { package: "x.p", dependencies: [dep], configTemplates: { default: { path: "c/d.yaml", default: true, description: "recommended" } } }, {
    "capabilities/a": { capability: "x.a", version: "2.1.0", commands: { go: "bin/go.mjs run" } },
  });
  write(join(src, "capabilities/a/bin/go.mjs"), "//\n");
  write(join(src, "c/d.yaml"), "name: adopted\n");
  const s = scope(t);
  gitify(s);

  // 1. A refusing gate: the CLI's guided `oas init --package` decides against
  //    the plan it was shown. NOTHING may have moved.
  let seen;
  const refuse = () => acquirePackage(s, src, { assertCommittable: (p) => { seen = p; throw new Error("operator declined the plan"); } });
  assert.throws(refuse, /operator declined the plan/);
  assert.equal(existsSync(join(s, OAS_LOCK_FILE)), false, "no lock byte");
  assert.equal(existsSync(join(s, ".agents/capabilities/installed")), false, "no artifact, no staging residue, not even the store root it had to create");
  assert.equal(existsSync(join(s, ".agents/capabilities/.gitignore")), false, "the ignore preflight had not run yet");

  // The preview is the full staged outcome, not just identities.
  assert.equal(seen.root, "x.p");
  const pkg = seen.packages.find((p) => p.package === "x.p");
  assert.deepEqual(Object.keys(pkg).sort(), ["capabilities", "commit", "dependencies", "integrity", "package", "path", "source", "version"]);
  assert.deepEqual(pkg.dependencies, ["x.dep"], "the whole closure is visible, not only the root");
  assert.deepEqual(seen.packages.map((p) => p.package).sort(), ["x.dep", "x.p"]);
  const cap = seen.capabilities.find((c) => c.capability === "x.a");
  assert.equal(cap.version, "2.1.0");
  assert.equal(cap.trusted, false);
  assert.equal(cap.status, "installed");
  assert.deepEqual(cap.executableSurface, { commands: ["go"], hooks: [] }, "the surface to approve is presentable BEFORE committing");
  assert.equal(Object.hasOwn(cap, "dir"), false, "staging paths are not exposed — the gate decides, it does not reach in");
  // Template bytes and digests are present, so adoption can be validated first.
  assert.equal(seen.configTemplates[0].content, "name: adopted\n");
  assert.equal(seen.configTemplates[0].description, "recommended");
  assert.match(seen.configTemplates[0].contentIntegrity, /^sha256-[0-9a-f]{64}$/);

  // 2. The observed bytes/digest are exactly what a committed acquire returns.
  const declined = { ...seen };
  const ok = acquirePackage(s, src, { assertCommittable: () => {} });
  assert.deepEqual(ok.configTemplates, declined.configTemplates, "the declined preview was the truth, not an estimate");
  assert.deepEqual(ok.capabilities.map((c) => c.capability).sort(), declined.capabilities.map((c) => c.capability).sort());
  assert.equal(lockOf(s).capabilities["x.a"].integrity, declined.capabilities.find((c) => c.capability === "x.a").integrity);

  // 3. Refusing an UPDATE is byte-exact for the same reason.
  const lockBefore = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const artifactBefore = capabilityArtifactIntegrity(artifact(s, "x.a"));
  const ignoreBefore = readFileSync(join(s, ".agents/capabilities/.gitignore"), "utf8");
  write(join(src, "capabilities/a/new.md"), "changed\n");
  assert.throws(() => acquirePackage(s, src, { replace: true, expectPackage: "x.p", assertCommittable: () => { throw new Error("nope"); } }), /nope/);
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore);
  assert.equal(capabilityArtifactIntegrity(artifact(s, "x.a")), artifactBefore);
  assert.equal(readFileSync(join(s, ".agents/capabilities/.gitignore"), "utf8"), ignoreBefore);
  assert.deepEqual(readdirSync(join(s, ".agents/capabilities/installed")).sort(), ["x.a", "x.d"]);
});

test("acquire is incremental: packages outside the closure keep their artifacts, rows and trust", () => {
  const t = temp();
  const s = scope(t);
  const first = pkgSource(join(t, "first"), { package: "x.first" }, { "capabilities/a": { capability: "x.a", commands: { go: "bin/go.mjs run" } } });
  write(join(first, "capabilities/a/bin/go.mjs"), "//\n");
  acquirePackage(s, first);
  approveCapability(s, "x.a");
  const firstRow = { ...lockOf(s).packages["x.first"] };
  const firstCap = { ...lockOf(s).capabilities["x.a"] };

  acquirePackage(s, pkgSource(join(t, "second"), { package: "x.second" }, { "capabilities/b": { capability: "x.b" } }));
  assert.deepEqual(lockOf(s).packages["x.first"], firstRow, "an unrelated package row is untouched");
  assert.deepEqual(lockOf(s).capabilities["x.a"], firstCap, "including its approval");
  assert.equal(lockOf(s).capabilities["x.a"].trusted, true);
});

// ---------- runtime closure ----------

test("materializeCapabilityDeps: npm ci --ignore-scripts only; lifecycle scripts never run", { skip: !hasNpm() }, () => {
  const t = temp();
  const capDir = join(t, "cap");
  write(join(capDir, "oas.json"), JSON.stringify({ capability: "x.a", version: "1.0.0", description: "d" }));
  write(join(capDir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", private: true, scripts: { preinstall: `node -e "require('fs').writeFileSync('${join(t, "SCRIPT-RAN")}','x')"` }, dependencies: {} }));
  write(join(capDir, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: "1.0.0" } } }));
  const r = materializeCapabilityDeps(capDir);
  assert.equal(r.error, undefined);
  assert.equal(existsSync(join(t, "SCRIPT-RAN")), false, "no npm lifecycle script ever runs");
  // A root with no lockfile is a successful no-op, not a failure.
  assert.equal(materializeCapabilityDeps(join(t, "nolock")).empty, true);
});

test("platformVariantLockPackages: os/cpu/libc, optional variance and install scripts are rejected; dev/peer are out of scope", () => {
  const t = temp();
  const lock = (packages) => { const f = join(t, `l${Math.random().toString(36).slice(2)}.json`); write(f, JSON.stringify({ lockfileVersion: 3, packages })); return f; };
  assert.deepEqual(platformVariantLockPackages(lock({ "": {}, "node_modules/a": {} })), []);
  assert.match(platformVariantLockPackages(lock({ "node_modules/a": { os: ["darwin"] } }))[0], /os\/cpu\/libc/);
  assert.match(platformVariantLockPackages(lock({ "node_modules/a": { cpu: ["arm64"] } }))[0], /os\/cpu\/libc/);
  assert.match(platformVariantLockPackages(lock({ "node_modules/a": { libc: ["glibc"] } }))[0], /os\/cpu\/libc/);
  assert.match(platformVariantLockPackages(lock({ "node_modules/a": { optional: true } }))[0], /optional/);
  assert.match(platformVariantLockPackages(lock({ "node_modules/a": { hasInstallScript: true } }))[0], /install script/);
  // Truly dev-only / peer-only entries are never materialized, so they cannot fail a valid closure.
  assert.deepEqual(platformVariantLockPackages(lock({ "node_modules/a": { dev: true, os: ["darwin"] }, "node_modules/b": { peer: true, hasInstallScript: true } })), []);
  // npm lockfileVersion 1 has no packages map: fail closed rather than under-scan.
  const v1 = join(t, "v1.json"); write(v1, JSON.stringify({ lockfileVersion: 1, dependencies: {} }));
  assert.match(platformVariantLockPackages(v1)[0], /unsupported npm lockfileVersion/);
});

test("a platform-variant closure is rejected transaction-wide, before any npm ci and before anything is installed", () => {
  const t = temp();
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" }, "capabilities/b": { capability: "x.b" } });
  // The FIRST capability is clean; the second is variant. Nothing may install.
  write(join(src, "capabilities/a/package.json"), JSON.stringify({ name: "a", version: "1.0.0" }));
  write(join(src, "capabilities/a/package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "a" } } }));
  write(join(src, "capabilities/b/package.json"), JSON.stringify({ name: "b", version: "1.0.0" }));
  write(join(src, "capabilities/b/package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "b" }, "node_modules/n": { os: ["darwin"] } } }));
  const s = scope(t);
  throwsCode(() => acquirePackage(s, src), "invalid-package-manifest", "variant closure");
  assert.equal(existsSync(join(s, OAS_LOCK_FILE)), false);
  assert.equal(existsSync(artifact(s, "x.a")), false, "the clean capability never materialized ahead of the rejected one");
});

test("materialized dependency symlinks must resolve inside the CAPABILITY artifact root", () => {
  const t = temp();
  const outside = join(t, "outside"); write(join(outside, "x.js"), "//\n");
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a" } });
  mkdirSync(join(src, "capabilities/a/node_modules"), { recursive: true });
  symlinkSync(outside, join(src, "capabilities/a/node_modules/escape"));
  const s = scope(t);
  throwsCode(() => acquirePackage(s, src), "path-escape", "escaping node_modules link");
  assert.equal(existsSync(join(s, OAS_LOCK_FILE)), false);
  // A broken link fails too.
  rmSync(join(src, "capabilities/a/node_modules/escape"));
  symlinkSync(join(t, "nothing-here"), join(src, "capabilities/a/node_modules/broken"));
  throwsCode(() => acquirePackage(s, src), "path-escape", "broken node_modules link");
});

// ---------- copyTreeSafe (process-abort regression) ----------

test("copyTreeSafe: verbatim symlinks, deterministic order, modes after children, fail-closed on special files", () => {
  const t = temp();
  const src = join(t, "src");
  write(join(src, "b.txt"), "b\n");
  write(join(src, "a/inner.txt"), "inner\n");
  symlinkSync("./b.txt", join(src, "link"));
  chmodSync(join(src, "a"), 0o500); // read-only directory: children must still copy
  const dest = join(t, "dest");
  copyTreeSafe(src, dest);
  assert.equal(readFileSync(join(dest, "a/inner.txt"), "utf8"), "inner\n");
  assert.equal(lstatSync(join(dest, "link")).isSymbolicLink(), true);
  assert.equal(execFileSync("readlink", [join(dest, "link")], { encoding: "utf8" }).trim(), "./b.txt", "link target is verbatim, never rewritten");
  assert.equal(lstatSync(join(dest, "a")).mode & 0o777, 0o500, "directory mode is applied after its children");
  chmodSync(join(dest, "a"), 0o700);
  // A FIFO is not distributable content.
  const fifoDir = join(t, "fifo");
  mkdirSync(fifoDir, { recursive: true });
  const mk = spawnSync("mkfifo", [join(fifoDir, "pipe")]);
  if (mk.status === 0) throwsCode(() => copyTreeSafe(fifoDir, join(t, "fifo-dest")), "invalid-source", "FIFO");
});

// A regression here ABORTS the process (native cpSync recursion on an unreadable
// directory raises an uncaught libc++ filesystem_error), so it runs in a child:
// a failure must not take the whole test runner down with it.
test("an unreadable directory inside a package tree fails catchably, leaving no staging, lock or artifact", { skip: process.getuid?.() === 0 }, () => {
  const t = temp();
  const probe = join(t, "probe.mjs");
  write(probe, `
import { mkdirSync, writeFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { acquirePackage } from ${JSON.stringify(resolve(new URL("../lib/core.mjs", import.meta.url).pathname))};
const base = process.argv[2];
const src = join(base, "src");
mkdirSync(join(src, "capabilities/a/locked"), { recursive: true });
writeFileSync(join(src, "capabilities/a/locked/secret.txt"), "x");
writeFileSync(join(src, "capabilities/a/oas.json"), JSON.stringify({ capability: "x.a", version: "1.0.0", description: "d" }));
writeFileSync(join(src, "oas-package.json"), JSON.stringify({ package: "x.p", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"] }));
const scope = join(base, "scope");
mkdirSync(scope, { recursive: true });
writeFileSync(join(scope, "oas-config.yaml"), "name: t\\n");
chmodSync(join(src, "capabilities/a/locked"), 0o000);
let code = "NO-THROW";
try { acquirePackage(scope, src); } catch (e) { code = e.code || e.constructor.name; }
chmodSync(join(src, "capabilities/a/locked"), 0o700);
const installed = join(scope, ".agents/capabilities/installed");
console.log(JSON.stringify({
  code,
  lock: existsSync(join(scope, "oas-lock.json")),
  installed: existsSync(installed) ? readdirSync(installed) : [],
}));
`);
  const r = spawnSync(process.execPath, [probe, t], { encoding: "utf8" });
  assert.equal(r.status, 0, `the probe must exit cleanly, not abort — stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.notEqual(out.code, "NO-THROW", "an unreadable tree must fail, not silently install a partial artifact");
  assert.equal(out.lock, false, "no lock was written");
  assert.deepEqual(out.installed, [], "no artifact and no staging left behind");
});

// ---------- containment at runtime ----------

test("a materialized artifact IS its own containment boundary, and tampering with it is visible", () => {
  const t = temp();
  const s = scope(t, "scope", "name: t\ncapabilities:\n  additive:\n    x.a:\n      global: true\n");
  const src = pkgSource(join(t, "src"), { package: "x.p" }, { "capabilities/a": { capability: "x.a", skills: ["skills/s"] } });
  write(join(src, "capabilities/a/skills/s/SKILL.md"), "# s\n");
  acquirePackage(s, src);
  const m = capabilityManifest("x.a", s);
  // The capability resolves to its OWN flat root — never to a shared package directory.
  assert.equal(realpathSync(m._dir), realpathSync(artifact(s, "x.a")));
  assert.equal(realpathSync(m._dir).startsWith(realpathSync(join(s, ".agents/capabilities/installed"))), true);
  // A link planted into the installed artifact that escapes it is drift: the
  // artifact hash covers every byte, so restore refuses to call it ok.
  symlinkSync(t, join(artifact(s, "x.a"), "skills/s/escape"));
  assert.notEqual(capabilityArtifactIntegrity(artifact(s, "x.a")), lockOf(s).capabilities["x.a"].integrity);
  assert.equal(restorePackages(s).find((r) => r.capability === "x.a").status, "restored", "a tampered artifact is reprojected from the locked source");
  assert.equal(existsSync(join(artifact(s, "x.a"), "skills/s/escape")), false);
  assert.equal(capabilityArtifactIntegrity(artifact(s, "x.a")), lockOf(s).capabilities["x.a"].integrity);
});

function hasNpm() {
  return spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
}

// ---------- v1 migration ----------

test("migrate: an empty v1 lock reports a FORMAT conversion and converts only when applied", () => {
  const t = temp();
  const s = scope(t);
  write(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: {} }));
  const plan = migrateLegacyLock(s);
  assert.equal(plan.from, 1);
  assert.equal(plan.convertible, true);
  assert.equal(plan.plan[0].action, "convert-format");
  assert.equal(lockOf(s).lockfileVersion, 1, "planning converts nothing");
  const r = applyLegacyLockMigration(s);
  assert.equal(r.formatConverted, true);
  assert.deepEqual(lockOf(s), { lockfileVersion: 2, packages: {}, capabilities: {} });
});

test("migrate: a v1 scope converts wholly into materialized capabilities, and trust is re-earned", () => {
  const t = temp();
  const repo = pkgSource(join(t, "repo", "oas-package"), { package: "x.official" }, { "capabilities/a": { capability: "x.a", commands: { go: "bin/go.mjs run" } } });
  write(join(repo, "capabilities/a/bin/go.mjs"), "//\n");
  const commit = gitify(join(t, "repo"));
  const catalog = (id) => (id === "x.official" ? { url: `file://${join(t, "repo")}`, ref: commit, path: "oas-package" } : undefined);
  const s = scope(t, "scope", "name: t\ncapabilities:\n  additive:\n    x.a:\n      global: true\n      from: installed\n");
  // A v1 lock with an approved marketplace capability.
  write(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: { "x.a": { source: "marketplace:x.a@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}`, trustedExecutables: true } } }, null, 2));

  const r = applyLegacyLockMigration(s, { catalog, aliases: { "x.a": "x.official" }, official: true });
  assert.deepEqual(r.migrated.map((m) => m.capability), ["x.a"]);
  assert.equal(lockOf(s).lockfileVersion, 2);
  assert.equal(lockOf(s).capabilities["x.a"].package, "x.official");
  assert.equal(lockOf(s).capabilities["x.a"].trusted, false, "v1 approval is NEVER carried over — different bytes");
  assert.deepEqual(r.trust.map((x) => x.capability), ["x.a"], "the surfaces to re-approve are named");
  assert.ok(existsSync(artifact(s, "x.a")));
  assert.deepEqual(activeIds(s), ["x.a"], "activation is preserved — `from: installed` still means installed");
});

test("migrate: one unmappable entry keeps the WHOLE scope on v1, byte-identical, and it keeps working", () => {
  const t = temp();
  const s = scope(t);
  const v1 = { lockfileVersion: 1, capabilities: { "x.mappable": { source: "marketplace:x.mappable@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` }, "x.orphan": { source: "marketplace:x.orphan@1.0.0", version: "1.0.0", integrity: `sha256-${"b".repeat(64)}` } } };
  write(join(s, OAS_LOCK_FILE), JSON.stringify(v1, null, 2));
  const before = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const catalog = (id) => (id === "x.mappable" ? { url: "file:///nowhere", ref: "0".repeat(40) } : undefined);

  const plan = migrateLegacyLock(s, { catalog });
  assert.equal(plan.convertible, false, "there is no residue container, so partial conversion is not an option");
  assert.ok(plan.plan.some((p) => p.capabilityId === "x.orphan" && p.action === "manual"));

  throwsCode(() => applyLegacyLockMigration(s, { catalog }), "legacy-lock", "unmappable entry");
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), before, "the scope stays v1, byte-identical");
});

test("migrate: guided official mode holds an unmappable official capability and leaves the scope untouched", () => {
  const t = temp();
  const s = scope(t);
  write(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: { "x.a": { source: "marketplace:x.a@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` } } }, null, 2));
  const before = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  throwsCode(() => applyLegacyLockMigration(s, { catalog: () => undefined, official: true }), "official-mapping-unavailable", "no catalog mapping");
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), before);
});

test("migrate: a failed conversion restores the original v1 lock byte-identically and removes what it created", () => {
  const t = temp();
  // Two capabilities from two packages; the second package is broken.
  const goodRepo = pkgSource(join(t, "good", "oas-package"), { package: "x.good" }, { "capabilities/a": { capability: "x.a" } });
  const goodCommit = gitify(join(t, "good"));
  const badRepo = join(t, "bad", "oas-package");
  write(join(badRepo, "capabilities/b/oas.json"), JSON.stringify({ capability: "x.b", version: "1.0.0", description: "d", skills: ["missing"] }));
  write(join(badRepo, "oas-package.json"), JSON.stringify({ package: "x.bad", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/b"] }));
  const badCommit = gitify(join(t, "bad"));
  const catalog = (id) => ({
    "x.good": { url: `file://${join(t, "good")}`, ref: goodCommit, path: "oas-package" },
    "x.bad": { url: `file://${join(t, "bad")}`, ref: badCommit, path: "oas-package" },
  }[id]);
  const aliases = { "x.a": "x.good", "x.b": "x.bad" };
  const s = scope(t);
  const v1 = { lockfileVersion: 1, capabilities: { "x.a": { source: "marketplace:x.a@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` }, "x.b": { source: "marketplace:x.b@1.0.0", version: "1.0.0", integrity: `sha256-${"b".repeat(64)}` } } };
  write(join(s, OAS_LOCK_FILE), JSON.stringify(v1, null, 2));
  const before = readFileSync(join(s, OAS_LOCK_FILE), "utf8");

  assert.throws(() => applyLegacyLockMigration(s, { catalog, aliases, official: true }));
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), before, "original v1 lock restored byte-identically");
  const installed = join(s, ".agents/capabilities/installed");
  assert.deepEqual(existsSync(installed) ? readdirSync(installed) : [], [], "every artifact the conversion created was removed");
});

test("migrate: a v1 lock with only custom sources is left exactly as it is by the guided command", () => {
  const t = temp();
  const s = scope(t);
  const v1 = { lockfileVersion: 1, capabilities: { "x.custom": { source: "git:https://example.invalid/x.git", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` } } };
  write(join(s, OAS_LOCK_FILE), JSON.stringify(v1, null, 2));
  const before = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const r = applyLegacyLockMigration(s, { catalog: () => undefined, official: true });
  assert.equal(r.skipped, true);
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), before);
});
