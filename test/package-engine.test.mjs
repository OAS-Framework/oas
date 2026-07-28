// Distribution package engine tests (docs/design/package-engine-contract.md).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  acquireCapability, acquirePackage, applyLegacyLockMigration, approveCapability, capabilityIntegrity, capabilityManifests, capabilityManifest, capabilityTrust,
  capabilitySkillDirs, capabilityExecutablePath, listInstalledPackages, loadPackageManifestAt, migrateLegacyLock,
  inspectGitSourceRoot, materializePackageDeps, packageDepsIntegrity, platformVariantLockPackages, packageIntegrity, parsePackageSource, readPackageLocks, removePackage, resolveOasConfig, restoreCapabilities, restorePackages,
  DEFAULT_PACKAGE_PATH, normalizePackagePath,
  findAgent, findCapabilityAgent, spawnInstance, updatePackage, validateLockEntry, writeCapabilityLock, writePackageLock, installedPackagesDir, OAS_LOCK_FILE,
} from "../lib/core.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
function temp() { return mkdtempSync(join(tmpdir(), "oas-pkg-test-")); }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function cli(cwd, ...argv) { return spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: "utf8" }); }
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
  write(join(dir, "oas-package.json"), JSON.stringify({ version: "1.0.0", description: "pkg", compatibility: { oas: ">=0.1.0" }, capabilities: caps, ...manifest }, null, 2));
  return dir;
}
/** A scope with an oas-config.yaml so the config chain sees it. */
function scope(base, name = "scope", config = "name: test\n") {
  const dir = join(base, name);
  write(join(dir, "oas-config.yaml"), config);
  return dir;
}

// ---------- source parsing ----------

test("parsePackageSource: git shorthand, raw URLs, paths, catalog ids, invalids", () => {
  const sh = parsePackageSource("git:github.com/org/repo@v1.2.0");
  assert.deepEqual({ kind: sh.kind, url: sh.url, ref: sh.ref }, { kind: "git", url: "https://github.com/org/repo.git", ref: "v1.2.0" });
  assert.equal(sh.normalized, "git:https://github.com/org/repo.git@v1.2.0");
  assert.equal(parsePackageSource("git:github.com/org/repo").ref, undefined);
  const https = parsePackageSource("https://host/org/repo.git@abc123");
  assert.deepEqual({ kind: https.kind, url: https.url, ref: https.ref }, { kind: "git", url: "https://host/org/repo.git", ref: "abc123" });
  assert.equal(parsePackageSource("https://host/org/repo.git").ref, undefined);
  const ssh = parsePackageSource("git@host:org/repo.git@v2");
  assert.equal(ssh.kind, "git"); assert.equal(ssh.ref, "v2"); assert.equal(ssh.url, "git@host:org/repo.git");
  const p = parsePackageSource("./local/pkg");
  assert.equal(p.kind, "path"); assert.ok(p.normalized.startsWith("path:/"));
  assert.equal(parsePackageSource("path:/abs/dir").path, "/abs/dir");
  const cat = parsePackageSource("oas.okf@v1.4.0");
  assert.deepEqual({ kind: cat.kind, id: cat.id, selector: cat.selector, normalized: cat.normalized }, { kind: "catalog", id: "oas.okf", selector: "v1.4.0", normalized: "catalog:oas.okf@v1.4.0" });
  assert.deepEqual({ selector: parsePackageSource("oas.okf").selector, normalized: parsePackageSource("oas.okf").normalized }, { selector: undefined, normalized: "catalog:oas.okf" });
  for (const bad of ["", "  ", "git:norepo", "Not A Source!", "UPPER"]) {
    assert.throws(() => parsePackageSource(bad), (e) => e.code === "invalid-source", bad);
  }
});

// ---------- manifest validation ----------

test("loadPackageManifestAt: valid manifest with capabilities and configs", () => {
  const base = temp();
  const dir = pkgSource(join(base, "p"), {
    package: "example.engineering",
    compatibility: { oas: ">=0.6.2" },
    configs: { default: { path: "configs/default/oas-config.yaml", default: true }, minimal: { path: "configs/minimal/oas-config.yaml" } },
  }, { "capabilities/review": { capability: "example.review" }, "capabilities/delivery": { capability: "example.delivery" } });
  write(join(dir, "configs/default/oas-config.yaml"), "name: x\n");
  write(join(dir, "configs/minimal/oas-config.yaml"), "name: y\n");
  const m = loadPackageManifestAt(dir);
  assert.equal(m.package, "example.engineering");
  assert.deepEqual(m._capabilities.map((c) => c.id).sort(), ["example.delivery", "example.review"]);
  rmSync(base, { recursive: true, force: true });
});

test("loadPackageManifestAt: rejects bad identity, unknown keys, missing paths, dup capability, multi-default", () => {
  const base = temp();
  const mk = (m, caps) => { const d = join(base, `p${Math.random().toString(36).slice(2)}`); return pkgSource(d, m, caps); };
  assert.throws(() => loadPackageManifestAt(mk({ package: "Bad Id" })), (e) => e.code === "invalid-package-manifest");
  assert.throws(() => loadPackageManifestAt(mk({ package: "a.b", extra: 1 })), (e) => /unknown keys/.test(e.message));
  assert.throws(() => loadPackageManifestAt(mk({ package: "a.b", capabilities: ["nope/missing"] })), (e) => /missing capability path/.test(e.message));
  assert.throws(() => loadPackageManifestAt(mk({ package: "a.b" }, { "c1": { capability: "x.same" }, "c2": { capability: "x.same" } })), (e) => e.code === "duplicate-capability-id");
  const multi = mk({ package: "a.b", configs: { a: { path: "a.yaml", default: true }, b: { path: "b.yaml", default: true } } });
  write(join(multi, "a.yaml"), "x\n"); write(join(multi, "b.yaml"), "x\n");
  assert.throws(() => loadPackageManifestAt(multi), (e) => /default/.test(e.message));
  // a capability path that is not a capability
  const notcap = mk({ package: "a.c", capabilities: ["plain"] });
  mkdirSync(join(notcap, "plain"), { recursive: true });
  assert.throws(() => loadPackageManifestAt(notcap), (e) => /no oas.json/.test(e.message));
  rmSync(base, { recursive: true, force: true });
});

test("loadPackageManifestAt: path escape — .. segments and symlinks out of the root", () => {
  const base = temp();
  const d1 = pkgSource(join(base, "esc1"), { package: "a.esc", capabilities: ["../outside"] });
  write(join(base, "outside", "oas.json"), "{}");
  assert.throws(() => loadPackageManifestAt(d1), (e) => e.code === "path-escape");
  // symlinked capability dir pointing outside the package root
  const d2 = pkgSource(join(base, "esc2"), { package: "a.esc2", capabilities: [] });
  write(join(base, "elsewhere", "oas.json"), JSON.stringify({ capability: "x.out", version: "1", description: "d" }));
  symlinkSync(join(base, "elsewhere"), join(d2, "linked"));
  write(join(d2, "oas-package.json"), JSON.stringify({ package: "a.esc2", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: ["linked"] }));
  assert.throws(() => loadPackageManifestAt(d2), (e) => e.code === "path-escape");
  rmSync(base, { recursive: true, force: true });
});

test("loadPackageManifestAt: rejects retired exported capability", () => {
  const base = temp();
  const d = pkgSource(join(base, "p"), { package: "a.ret" }, { "cap": { capability: "oas.web" } });
  assert.throws(() => loadPackageManifestAt(d), (e) => e.code === "retired-capability");
  rmSync(base, { recursive: true, force: true });
});

// ---------- lock v2 read/write ----------

test("writePackageLock/readPackageLocks: v2 round-trip, closest scope wins, refuses v1 files", () => {
  const base = temp();
  const outer = scope(base, "outer");
  const inner = scope(join(base, "outer"), "inner");
  writePackageLock(outer, "a.pkg", { source: "path:/x", path: ".", version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`, capabilities: ["a.cap"] });
  writePackageLock(inner, "a.pkg", { source: "path:/y", path: ".", version: "2.0.0", commit: "local", integrity: `sha256-${"1".repeat(64)}`, capabilities: ["a.cap"] });
  const locks = readPackageLocks(inner);
  assert.equal(locks.packages["a.pkg"].version, "2.0.0"); // closer wins
  assert.equal(readPackageLocks(outer).packages["a.pkg"].version, "1.0.0");
  // v1 file refuses package writes with legacy-lock
  const v1 = scope(base, "v1scope");
  writeCapabilityLock(v1, "old.cap", { source: "marketplace:old.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"c".repeat(64)}` });
  assert.throws(() => writePackageLock(v1, "a.pkg", { source: "path:/z", path: ".", version: "1", commit: "local", integrity: `sha256-${"2".repeat(64)}`, capabilities: [] }), (e) => e.code === "legacy-lock");
  // legacy locks surface separately
  assert.equal(readPackageLocks(v1).legacy.length, 1);
  // deleting an entry
  writePackageLock(inner, "a.pkg", null);
  assert.equal(readPackageLocks(inner).packages["a.pkg"].version, "1.0.0"); // falls back to outer
  rmSync(base, { recursive: true, force: true });
});

test("writeCapabilityLock never downgrades a v2 lock and refuses NEW legacy entries there", () => {
  const base = temp();
  const s = scope(base);
  writePackageLock(s, "a.pkg", { source: "path:/x", path: ".", version: "1", commit: "local", integrity: `sha256-${"0".repeat(64)}`, capabilities: [] });
  // Only `oas migrate` creates residue: adding a fresh legacy entry to a v2 lock is refused.
  assert.throws(() => writeCapabilityLock(s, "legacy.cap", { source: "path:/y", version: "1", integrity: `sha256-${"1".repeat(64)}` }), (e) => e.code === "legacy-lock");
  const parsed = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.equal(parsed.lockfileVersion, 2);
  assert.ok(parsed.packages["a.pkg"]);
  assert.equal(parsed.capabilities?.["legacy.cap"], undefined);
  rmSync(base, { recursive: true, force: true });
});

// ---------- acquire: closure, cycles, collisions ----------

test("acquirePackage: local package with git dependency closure, exact lock, nothing activated", () => {
  const base = temp();
  const s = scope(base);
  // dependency package as a git repo
  const depSrc = pkgSource(join(base, "dep-src"), { package: "dep.pkg" }, { "cap": { capability: "dep.cap" } });
  const depCommit = gitify(depSrc);
  // root package (local path) depending on the pinned git dep
  const rootSrc = pkgSource(join(base, "root-src"), { package: "root.pkg", dependencies: [`file://${depSrc}@${depCommit}#.`] }, { "cap": { capability: "root.cap", commands: { run: { exec: "x.mjs" } } } });
  write(join(rootSrc, "cap", "x.mjs"), "// exec\n");
  const r = acquirePackage(s, rootSrc);
  assert.equal(r.root, "root.pkg");
  assert.deepEqual(r.installed.map((p) => p.package).sort(), ["dep.pkg", "root.pkg"]);
  const locks = readPackageLocks(s).packages;
  assert.equal(locks["root.pkg"].commit, "local");
  assert.equal(locks["dep.pkg"].commit, depCommit);
  assert.deepEqual(locks["root.pkg"].dependencies, ["dep.pkg"]);
  assert.deepEqual(locks["root.pkg"].capabilities, ["root.cap"]);
  assert.deepEqual(locks["root.pkg"].trustedCapabilities, []);
  assert.ok(existsSync(join(installedPackagesDir(s), "root.pkg", "oas-package.json")));
  assert.ok(existsSync(join(installedPackagesDir(s), "dep.pkg", "oas-package.json")));
  // staging cleaned
  assert.ok(!readFileSync(join(s, OAS_LOCK_FILE), "utf8").includes(".staging"));
  // nothing activated: config untouched
  assert.equal(readFileSync(join(s, "oas-config.yaml"), "utf8"), "name: test\n");
  rmSync(base, { recursive: true, force: true });
});

test("acquirePackage: unpinned git dependency is rejected; cycles and identity collisions error with provenance", () => {
  const base = temp();
  const s = scope(base);
  const dep = pkgSource(join(base, "dep"), { package: "d.p" });
  gitify(dep);
  const unpinned = pkgSource(join(base, "u"), { package: "u.p", dependencies: [`file://${dep}#.`] });
  assert.throws(() => acquirePackage(s, unpinned), (e) => e.code === "invalid-source" && /pinned/.test(e.message));
  // cycle: a → b → a  (local path deps)
  const a = join(base, "a"); const b = join(base, "b");
  pkgSource(a, { package: "a.p", dependencies: [b] });
  pkgSource(b, { package: "b.p", dependencies: [a] });
  assert.throws(() => acquirePackage(scope(base, "s2"), a), (e) => e.code === "dependency-cycle" && Array.isArray(e.provenance));
  // identity collision: two different sources claiming one identity
  const c1 = pkgSource(join(base, "c1"), { package: "same.id" });
  const c2 = pkgSource(join(base, "c2"), { package: "same.id", description: "other" });
  const rootC = pkgSource(join(base, "rc"), { package: "r.p", dependencies: [c1, c2] });
  assert.throws(() => acquirePackage(scope(base, "s3"), rootC), (e) => e.code === "duplicate-package-identity" && e.provenance.length === 2);
  rmSync(base, { recursive: true, force: true });
});

test("acquirePackage: same-scope duplicate exported capability id errors; different scopes coexist", () => {
  const base = temp();
  const s = scope(base);
  const p1 = pkgSource(join(base, "p1"), { package: "one.p" }, { "cap": { capability: "shared.cap" } });
  const p2 = pkgSource(join(base, "p2"), { package: "two.p" }, { "cap": { capability: "shared.cap" } });
  acquirePackage(s, p1);
  assert.throws(() => acquirePackage(s, p2), (e) => e.code === "duplicate-capability-id");
  // closer scope may override with a different version of the same package
  const inner = scope(s, "inner");
  const p1v2 = pkgSource(join(base, "p1v2"), { package: "one.p", version: "2.0.0" }, { "cap": { capability: "shared.cap" } });
  acquirePackage(inner, p1v2);
  const pkgs = listInstalledPackages(inner);
  assert.equal(pkgs.find((p) => p.package === "one.p").version, "2.0.0"); // closest wins
  assert.equal(listInstalledPackages(s).find((p) => p.package === "one.p").version, "1.0.0");
  rmSync(base, { recursive: true, force: true });
});

test("acquirePackage: catalog resolver boundary — identity/discovery only, injected catalog, no executable trust", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "official"), { package: "oas.thing" }, { "cap": { capability: "oas.thing", commands: { go: { exec: "go.mjs" } } } });
  write(join(src, "cap", "go.mjs"), "// x\n");
  gitify(src);
  const catalog = (id) => (id === "oas.thing" ? { url: src, path: "." } : undefined);
  const r = acquirePackage(s, "oas.thing", { catalog });
  assert.equal(r.root, "oas.thing");
  const lock = readPackageLocks(s).packages["oas.thing"];
  assert.equal(lock.source, "catalog:oas.thing", "bare original catalog spec is preserved separately from the resolved commit");
  assert.deepEqual(lock.trustedCapabilities, []); // official identity grants NO executable trust
  assert.throws(() => acquirePackage(scope(base, "s2"), "not.in.catalog", { catalog }), (e) => e.code === "invalid-source");
  rmSync(base, { recursive: true, force: true });
});

test("acquirePackage: legacy v1 lock at the scope blocks package install with legacy-lock", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "old.cap", { source: "marketplace:old.cap@1", version: "1", integrity: `sha256-${"c".repeat(64)}` });
  const p = pkgSource(join(base, "p"), { package: "n.p" });
  assert.throws(() => acquirePackage(s, p), (e) => e.code === "legacy-lock");
  rmSync(base, { recursive: true, force: true });
});

test("acquirePackage: incompatible compatibility.oas floor is rejected", () => {
  const base = temp();
  const p = pkgSource(join(base, "p"), { package: "f.p", compatibility: { oas: ">=999.0.0" } });
  assert.throws(() => acquirePackage(scope(base), p), (e) => e.code === "incompatible-oas");
  rmSync(base, { recursive: true, force: true });
});

// ---------- restore ----------

test("restorePackages: exact restore from lock (commit + integrity), transactional; drift fails", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "g.p" }, { "cap": { capability: "g.cap" } });
  gitify(src);
  acquirePackage(s, `file://${src}#.`);
  const store = join(installedPackagesDir(s), "g.p");
  const lockedIntegrity = readPackageLocks(s).packages["g.p"].integrity;
  // wipe the store; restore refetches at the exact commit
  rmSync(store, { recursive: true, force: true });
  let rep = restorePackages(s);
  assert.equal(rep.find((r) => r.package === "g.p").status, "restored");
  assert.equal(packageIntegrity(store), lockedIntegrity);
  // present + intact → ok
  rep = restorePackages(s);
  assert.equal(rep.find((r) => r.package === "g.p").status, "ok");
  // source advances; restore still lands the LOCKED commit (no silent advancement)
  write(join(src, "extra.md"), "later\n");
  gitCommit(src);
  rmSync(store, { recursive: true, force: true });
  rep = restorePackages(s);
  assert.equal(rep.find((r) => r.package === "g.p").status, "restored");
  assert.ok(!existsSync(join(store, "extra.md")));
  // integrity drift: tamper the lock's integrity → restore fails, nothing installed
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["g.p"].integrity = "sha256-" + "0".repeat(64);
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  rmSync(store, { recursive: true, force: true });
  rep = restorePackages(s);
  const fail = rep.find((r) => r.package === "g.p");
  assert.equal(fail.status, "failed");
  assert.equal(fail.code, "integrity-drift");
  assert.ok(!existsSync(store)); // transactional: no partial install
  rmSync(base, { recursive: true, force: true });
});

test("restorePackages: lock capabilities list is verified against the restored manifest", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "v.p" }, { "cap": { capability: "v.cap" } });
  gitify(src);
  acquirePackage(s, src);
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["v.p"].capabilities = ["v.cap", "phantom.cap"];
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  const rep = restorePackages(s);
  const r = rep.find((x) => x.package === "v.p");
  assert.equal(r.status, "failed");
  assert.equal(r.code, "capability-list-mismatch");
  rmSync(base, { recursive: true, force: true });
});

// ---------- discovery + activation ----------

test("discovery: package-exported capabilities are addressable with from: installed; owned keeps precedence; activation is explicit", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    pkg.cap:\n      from: installed\n      global: true\n");
  const src = pkgSource(join(base, "src"), { package: "prov.p" }, { "cap": { capability: "pkg.cap" }, "cap2": { capability: "pkg.other" } });
  acquirePackage(s, src);
  const mans = capabilityManifests(s);
  assert.ok(mans["pkg.cap"]);
  assert.equal(mans["pkg.cap"]._package, "prov.p");
  assert.ok(String(mans["pkg.cap"]._origin).startsWith("installed:"));
  assert.ok(mans["pkg.other"], "every exported capability independently addressable");
  const r = resolveOasConfig(s).capabilities.map((c) => ({ id: c.id }));
  assert.deepEqual(r.map((c) => c.id), ["pkg.cap"]); // pkg.other present but NOT active
  // owned capability of the same id at the scope wins over installed
  write(join(s, ".agents", "capabilities", "owned", "pkg-cap", "oas.json"), JSON.stringify({ capability: "pkg.cap", version: "9.9.9", description: "owned override" }));
  assert.equal(capabilityManifest("pkg.cap", s).version, "9.9.9");
  rmSync(base, { recursive: true, force: true });
});

test("discovery: two same-scope packages exporting one capability id is an error at list time", () => {
  const base = temp();
  const s = scope(base);
  const p1 = pkgSource(join(base, "p1"), { package: "l1.p" }, { "cap": { capability: "dup.cap" } });
  acquirePackage(s, p1);
  // simulate a second package landing out-of-band (bypassing acquire's check)
  const p2dir = join(installedPackagesDir(s), "l2.p");
  pkgSource(p2dir, { package: "l2.p" }, { "cap": { capability: "dup.cap" } });
  assert.throws(() => listInstalledPackages(s), (e) => e.code === "duplicate-capability-id");
  rmSync(base, { recursive: true, force: true });
});

// ---------- trust ----------

test("managed artifacts strip root VCS metadata and any later .git bytes invalidate trust until restore repairs them", () => {
  const base = temp();
  try {
    const level = scope(base);
    const source = pkgSource(join(base, "source"), { package: "acme.vcs" }, {
      "capabilities/run": { capability: "acme.run", commands: { go: "bin/run.mjs" } },
    });
    write(join(source, "capabilities/run/bin/run.mjs"), "export default 1;\n");
    // Local exact-root acquisition must strip source-control metadata just like
    // Git subtree acquisition; metadata is never managed package content.
    write(join(source, ".git", "config"), "source metadata\n");
    acquirePackage(level, source);
    const installed = join(installedPackagesDir(level), "acme.vcs");
    assert.equal(existsSync(join(installed, ".git")), false, "root .git is not installed");
    approveCapability(level, "acme.run");
    assert.equal(capabilityTrust(level, "acme.run").trusted, true);

    // Re-introducing the excluded-looking name after approval is ordinary
    // package tampering: its executable must never be approval-invisible.
    write(join(installed, ".git", "cap", "payload.mjs"), "export default 'tampered';\n");
    assert.equal(capabilityTrust(level, "acme.run").trusted, false, "inserted .git bytes invalidate package trust");
    assert.equal(packageIntegrity(installed) === readPackageLocks(level).packages["acme.vcs"].integrity, false);

    const report = restorePackages(level);
    assert.equal(report.find((r) => r.package === "acme.vcs")?.status, "ok");
    assert.equal(existsSync(join(installed, ".git")), false, "restore prunes root VCS metadata before the no-op fast path");
    assert.equal(capabilityTrust(level, "acme.run").trusted, true, "the locked package is usable after repair");

    // Standalone legacy capabilities obey the same invariant at their own v1
    // scope (a v2 package lock correctly forbids adding new legacy entries).
    const legacyLevel = scope(base, "legacy");
    const capSrc = join(base, "cap-src");
    write(join(capSrc, "oas.json"), JSON.stringify({ capability: "acme.legacy", version: "1.0.0", description: "legacy", commands: { go: "run.mjs" } }));
    write(join(capSrc, "run.mjs"), "export default 1;\n");
    write(join(capSrc, ".git", "config"), "source metadata\n");
    const acquired = acquireCapability(legacyLevel, capSrc);
    assert.equal(existsSync(join(acquired.dest, ".git")), false, "legacy acquisition also strips root .git");
    writeCapabilityLock(legacyLevel, "acme.legacy", { source: `path:${capSrc}`, version: "1.0.0", integrity: acquired.integrity, trustedExecutables: true });
    assert.equal(capabilityTrust(legacyLevel, "acme.legacy").trusted, true);
    write(join(acquired.dest, ".git", "payload.mjs"), "tampered\n");
    assert.equal(capabilityTrust(legacyLevel, "acme.legacy").trusted, false, "legacy .git insertion invalidates trust");
    const restored = restoreCapabilities(legacyLevel);
    assert.equal(restored.find((r) => r.id === "acme.legacy")?.status, "present");
    assert.equal(existsSync(join(acquired.dest, ".git")), false, "legacy restore present path repairs root VCS metadata");
    assert.equal(capabilityTrust(legacyLevel, "acme.legacy").trusted, true);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("trust: per-capability approval at exact package integrity; integrity change invalidates; non-executable needs none", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "t.p" }, {
    "cap": { capability: "t.exec", commands: { run: { exec: "run.mjs" } } },
    "cap2": { capability: "t.docs", skills: ["skills"] },
    "cap3": { capability: "t.exec2", hooks: { spawn: "hook.mjs" } },
  });
  write(join(src, "cap", "run.mjs"), "// x\n");
  write(join(src, "cap2", "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  write(join(src, "cap3", "hook.mjs"), "// h\n");
  acquirePackage(s, src);
  const mans = capabilityManifests(s);
  // untrusted executable capability is blocked; docs-only capability is trusted with lock integrity alone
  assert.equal(capabilityTrust(mans["t.exec"], s).trusted, false);
  assert.equal(capabilityTrust(mans["t.docs"], s).trusted, true);
  // approve ONLY t.exec — t.exec2 stays blocked
  const r = approveCapability(s, "t.exec");
  assert.deepEqual(r.approved, ["t.exec"]);
  assert.equal(capabilityTrust(capabilityManifests(s)["t.exec"], s).trusted, true);
  assert.equal(capabilityTrust(capabilityManifests(s)["t.exec2"], s).trusted, false);
  // bulk: package id + allCapabilities approves the remaining executable surface, skips docs-only
  const rb = approveCapability(s, "t.p", { allCapabilities: true });
  assert.deepEqual(rb.approved.sort(), ["t.exec", "t.exec2"]);
  assert.deepEqual(rb.skipped, ["t.docs"]);
  assert.ok(rb.executableSurface["t.exec"].commands.includes("run"));
  // integrity change invalidates: tamper the installed tree
  write(join(installedPackagesDir(s), "t.p", "cap", "run.mjs"), "// tampered\n");
  assert.equal(capabilityTrust(capabilityManifests(s)["t.exec"], s).trusted, false);
  assert.throws(() => approveCapability(s, "t.exec"), (e) => e.code === "integrity-drift");
  rmSync(base, { recursive: true, force: true });
});

test("trust: unknown capability/package errors; approvals reset when update changes integrity", () => {
  const base = temp();
  const s = scope(base);
  assert.throws(() => approveCapability(s, "no.such"), (e) => e.code === "unknown-capability");
  const src = pkgSource(join(base, "src"), { package: "u.p" }, { "cap": { capability: "u.exec", commands: { go: { exec: "go.mjs" } } } });
  write(join(src, "cap", "go.mjs"), "// v1\n");
  gitify(src);
  acquirePackage(s, src);
  approveCapability(s, "u.exec");
  assert.deepEqual(readPackageLocks(s).packages["u.p"].trustedCapabilities, ["u.exec"]);
  // source advances; update re-resolves, replaces artifact+lock, resets approvals
  write(join(src, "cap", "go.mjs"), "// v2\n");
  write(join(src, "oas-package.json"), JSON.stringify({ package: "u.p", version: "1.1.0", description: "pkg", compatibility: { oas: ">=0.1.0" }, capabilities: ["cap"] }));
  gitCommit(src);
  const r = updatePackage(s, "u.p");
  assert.equal(r.changed, true);
  assert.deepEqual(r.invalidatedApprovals, ["u.exec"]);
  assert.deepEqual(readPackageLocks(s).packages["u.p"].trustedCapabilities, []);
  assert.equal(readPackageLocks(s).packages["u.p"].version, "1.1.0");
  rmSync(base, { recursive: true, force: true });
});

// ---------- update / remove ----------

test("updatePackage: no-op when unchanged; transactional artifact+lock replacement when changed", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "up.p" }, { "cap": { capability: "up.cap" } });
  gitify(src);
  acquirePackage(s, src);
  const r0 = updatePackage(s, "up.p");
  assert.equal(r0.changed, false);
  write(join(src, "cap", "NEW.md"), "new file\n");
  gitCommit(src);
  const r1 = updatePackage(s, "up.p");
  assert.equal(r1.changed, true);
  assert.ok(existsSync(join(installedPackagesDir(s), "up.p", "cap", "NEW.md")));
  assert.equal(readPackageLocks(s).packages["up.p"].commit, r1.after.commit);
  assert.throws(() => updatePackage(s, "absent.p"), (e) => e.code === "unknown-capability");
  rmSync(base, { recursive: true, force: true });
});

test("removePackage: refuses while a dependent package or a config reference exists, then removes cleanly", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    rm.cap:\n      from: installed\n      global: true\n");
  const dep = pkgSource(join(base, "dep"), { package: "rm.dep" }, { "cap": { capability: "rm.cap" } });
  const depCommit = gitify(dep);
  const root = pkgSource(join(base, "root"), { package: "rm.root", dependencies: [`file://${dep}@${depCommit}#.`] });
  acquirePackage(s, root);
  // blocked: rm.root depends on rm.dep AND config references rm.cap
  assert.throws(() => removePackage(s, "rm.dep"), (e) => e.code === "remove-blocked" && /depends on it/.test(e.message) && /references capability/.test(e.message));
  // root is removable (nothing depends on it, no config reference)
  const r = removePackage(s, "rm.root");
  assert.ok(!existsSync(r.dir));
  assert.equal(readPackageLocks(s).packages["rm.root"], undefined);
  // config reference alone still blocks the dep
  assert.throws(() => removePackage(s, "rm.dep"), (e) => e.code === "remove-blocked");
  // drop the config reference → removable
  write(join(s, "oas-config.yaml"), "name: t\n");
  removePackage(s, "rm.dep");
  assert.deepEqual({ ...readPackageLocks(s).packages }, {});
  rmSync(base, { recursive: true, force: true });
});

// ---------- migration ----------

test("migrateLegacyLock + applyLegacyLockMigration: marketplace→catalog mapping, residue retention, activation preserved", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    mig.cap:\n      from: installed\n      global: true\n");
  // official package for mig.cap available through a fixture catalog
  const official = pkgSource(join(base, "official"), { package: "mig.cap" }, { "cap": { capability: "mig.cap" } });
  gitify(official);
  const catalog = (id) => (id === "mig.cap" ? { url: official, path: "." } : undefined);
  // v1 lock: one mappable marketplace entry, one unmappable
  writeCapabilityLock(s, "mig.cap", { source: "marketplace:mig.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}`, trustedExecutables: true });
  writeCapabilityLock(s, "gone.cap", { source: "marketplace:gone.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"b".repeat(64)}` });
  const { plan, warnings } = migrateLegacyLock(s, { catalog });
  assert.equal(plan.find((p) => p.capabilityId === "mig.cap").action, "acquire");
  assert.equal(plan.find((p) => p.capabilityId === "gone.cap").action, "manual");
  assert.ok(warnings.some((w) => /gone.cap/.test(w)));
  const r = applyLegacyLockMigration(s, { catalog });
  assert.deepEqual(r.migrated.map((m) => m.capability), ["mig.cap"]);
  assert.deepEqual(r.residue, ["gone.cap"]);
  const parsed = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.equal(parsed.lockfileVersion, 2);
  assert.ok(parsed.packages["mig.cap"]);
  assert.deepEqual(parsed.packages["mig.cap"].trustedCapabilities, [], "executable approvals are NOT carried over");
  assert.ok(parsed.capabilities["gone.cap"], "unmappable v1 entry retained as residue");
  assert.equal(parsed.capabilities["mig.cap"], undefined);
  // activation still resolves: from: installed now provided by the package
  assert.ok(capabilityManifests(s)["mig.cap"]);
  assert.equal(capabilityManifests(s)["mig.cap"]._package, "mig.cap");
  rmSync(base, { recursive: true, force: true });
});

test("migrateLegacyLock: git and path v1 sources map to acquirable package specs only when they are packages", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "g.cap", { source: "git:https://host/x.git", version: "1", commit: "abc", integrity: `sha256-${"c".repeat(64)}` });
  writeCapabilityLock(s, "p.cap", { source: "path:/some/dir", version: "1", integrity: `sha256-${"d".repeat(64)}` });
  const { plan } = migrateLegacyLock(s);
  // A v1 lock had no package-path concept: its artifact WAS the repository
  // root, so migration selects the root explicitly instead of inheriting the
  // new default contained path.
  assert.equal(plan.find((p) => p.capabilityId === "g.cap").package.spec, "https://host/x.git@abc#.");
  assert.equal(plan.find((p) => p.capabilityId === "p.cap").package.spec, "/some/dir");
  rmSync(base, { recursive: true, force: true });
});

// ---------- containment ----------

test("containment: package capability hook/exec paths resolve inside the locked package; escapes throw", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    c.esc:\n      from: installed\n      global: true\n");
  const src = pkgSource(join(base, "src"), { package: "c.p" }, { "cap": { capability: "c.esc", skills: ["skills"] } });
  write(join(src, "cap", "skills", "sk", "SKILL.md"), "---\nname: sk\ndescription: d\n---\n");
  acquirePackage(s, src);
  // a capability may reference a sibling resource inside the same PACKAGE root
  const dirs = capabilitySkillDirs("c.esc", s);
  assert.equal(dirs.length, 1);
  // symlink inside the installed tree pointing outside the package root → escape
  const capDir = join(installedPackagesDir(s), "c.p", "cap");
  write(join(base, "outside-file"), "secret\n");
  symlinkSync(join(base, "outside-file"), join(capDir, "skills", "sk", "leak"));
  assert.throws(() => capabilitySkillDirs("c.esc", s), /escapes its integrity boundary/);
  rmSync(join(capDir, "skills", "sk", "leak"));
  rmSync(base, { recursive: true, force: true });
});

test("containment: legacy marketplace residue never grants a PACKAGE-EXPORTED capability the framework-hoisted exemption", () => {
  // Framework-hoisted resolution exists only for kernel marketplace installs. A
  // package that exports a capability under an official id, in a scope whose
  // lock still carries that id's migration residue, must stay contained by its
  // own package root — otherwise a third-party package could borrow kernel
  // content (here: the real oas.authoring declaration) on the strength of a
  // legacy lock entry it does not own.
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    oas.authoring:\n      from: installed\n      global: true\n");
  const src = pkgSource(join(base, "src"), { package: "impostor.pkg" }, {
    "cap": { capability: "oas.authoring", version: "1.0.0", skills: ["../../skills/skill-craft"] },
  });
  acquirePackage(s, src);
  const lockFile = join(s, OAS_LOCK_FILE);
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  lock.capabilities = { "oas.authoring": { source: "marketplace:oas.authoring@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` } };
  writeFileSync(lockFile, JSON.stringify(lock, null, 2));
  const manifest = capabilityManifest("oas.authoring", s);
  assert.equal(manifest._package, "impostor.pkg", "the package-exported manifest is the one under test");
  assert.equal(manifest._marketplace, undefined, "residue does not flag a package-exported capability as marketplace-sourced");
  assert.deepEqual(capabilitySkillDirs("oas.authoring", s), [], "the kernel's skills/ never resolves for it");
  rmSync(base, { recursive: true, force: true });
});

// ---------- runtime deps ----------

test("materializePackageDeps: npm ci --ignore-scripts only; lifecycle scripts never run; integrity ignores node_modules", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "n.p" });
  // package.json with a malicious postinstall and no deps; a valid lockfile
  write(join(src, "package.json"), JSON.stringify({ name: "n-p", version: "1.0.0", scripts: { postinstall: `node -e "require('fs').writeFileSync('PWNED','x')"` } }));
  write(join(src, "package-lock.json"), JSON.stringify({ name: "n-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "n-p", version: "1.0.0" } } }));
  const before = packageIntegrity(src);
  acquirePackage(s, src);
  const dest = join(installedPackagesDir(s), "n.p");
  assert.ok(!existsSync(join(dest, "PWNED")), "postinstall must not run");
  assert.equal(readPackageLocks(s).packages["n.p"].integrity, before, "node_modules excluded from integrity");
  rmSync(base, { recursive: true, force: true });
});

// ---------- CLI surface ----------

test("CLI: install <package-source> locks + reports, bare install restores, list shows packages, remove refuses then removes", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "cli.p" }, { "cap": { capability: "cli.cap", commands: { run: { exec: "run.mjs" } } } });
  write(join(src, "cap", "run.mjs"), "// x\n");
  gitify(src);
  let r = cli(s, "install", src, "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Acquired cli\.p@1\.0\.0/);
  assert.match(r.stdout, /nothing activated/);
  assert.match(r.stdout, /oas trust cli\.cap/);
  // list
  r = cli(s, "list", "--dir", s);
  assert.match(r.stdout, /cli\.p@1\.0\.0/);
  assert.match(r.stdout, /capability cli\.cap.*needs oas trust/);
  // list --json envelope
  r = cli(s, "list", "--dir", s, "--json");
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.result.packages[0].package, "cli.p");
  // trust via CLI
  r = cli(s, "trust", "cli.cap", "--dir", s);
  assert.match(r.stdout, /Trusted executable commands\/hooks for cli\.cap/);
  // bare install restores after wiping the store
  rmSync(join(installedPackagesDir(s), "cli.p"), { recursive: true, force: true });
  r = cli(s, "install", "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restored\s+package cli\.p/);
  // trust survives restore at same integrity
  assert.deepEqual(readPackageLocks(s).packages["cli.p"].trustedCapabilities, ["cli.cap"]);
  // remove
  r = cli(s, "remove", "cli.p", "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(installedPackagesDir(s), "cli.p")));
  rmSync(base, { recursive: true, force: true });
});

test("CLI: trust <package> --all-capabilities prints the full executable-surface summary", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "bulk.p" }, {
    "c1": { capability: "bulk.a", commands: { x: { exec: "x.mjs" } } },
    "c2": { capability: "bulk.b", hooks: { spawn: "h.mjs" } },
  });
  write(join(src, "c1", "x.mjs"), "//\n"); write(join(src, "c2", "h.mjs"), "//\n");
  cli(s, "install", src, "--dir", s);
  const r = cli(s, "trust", "bulk.p", "--all-capabilities", "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bulk\.a: commands \[x\]/);
  assert.match(r.stdout, /bulk\.b: commands \[none\], hooks \[spawn\]/);
  assert.match(r.stdout, /Trusted executable commands\/hooks for bulk\.a, bulk\.b/);
  rmSync(base, { recursive: true, force: true });
});

test("CLI: migrate --dry-run plans and migrate applies; update <package> shows diff and invalidates approvals", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "x.cap", { source: "marketplace:x.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  let r = cli(s, "migrate", "--dry-run", "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /x\.cap/);
  r = cli(s, "migrate", "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /residue\s+x\.cap/); // not in any catalog
  assert.match(r.stdout, /lockfileVersion 2/);
  assert.equal(JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8")).lockfileVersion, 2);
  // update diff via CLI
  const src = pkgSource(join(base, "src"), { package: "cliup.p" }, { "cap": { capability: "cliup.cap", commands: { go: { exec: "g.mjs" } } } });
  write(join(src, "cap", "g.mjs"), "// v1\n");
  gitify(src);
  cli(s, "install", src, "--dir", s);
  cli(s, "trust", "cliup.cap", "--dir", s);
  write(join(src, "cap", "g.mjs"), "// v2\n");
  gitCommit(src);
  r = cli(s, "update", "cliup.p", "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Updated cliup\.p/);
  assert.match(r.stdout, /APPROVALS INVALIDATED.*cliup\.cap/);
  rmSync(base, { recursive: true, force: true });
});

test("CLI: doctor distinguishes package failures — missing locked package, integrity drift, untrusted surface, legacy lock", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "doc.p" }, { "cap": { capability: "doc.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  cli(s, "install", src, "--dir", s);
  let r = cli(s, "doctor", s);
  assert.match(r.stdout, /doc\.p@1\.0\.0/);
  assert.match(r.stdout, /executable surface UNTRUSTED/);
  // integrity drift
  write(join(installedPackagesDir(s), "doc.p", "cap", "r.mjs"), "// tampered\n");
  r = cli(s, "doctor", s);
  assert.match(r.stdout, /integrity drift/);
  // missing locked package
  rmSync(join(installedPackagesDir(s), "doc.p"), { recursive: true, force: true });
  r = cli(s, "doctor", s);
  assert.match(r.stdout, /locked in .* but not installed/);
  // legacy lock warning
  const s2 = scope(base, "legacy");
  writeCapabilityLock(s2, "old.cap", { source: "marketplace:old.cap@1", version: "1", integrity: `sha256-${"c".repeat(64)}` });
  r = cli(s2, "doctor", s2);
  assert.match(r.stdout, /lockfileVersion 1 .*oas migrate/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- end-to-end: acquire → lock → trust → activate → spawn probe ----------

test("clean fixture: acquire → lock → trust → activate → spawn probe with a package-exported capability", () => {
  const base = temp();
  // workspace scope with config activating the package capability globally
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: fixture\ncapabilities:\n  additive:\n    fx.cap:\n      from: installed\n      global: true\n");
  const src = pkgSource(join(base, "src"), { package: "fx.p" }, {
    "cap": { capability: "fx.cap", inject: "inject.md", skills: ["skills"], hooks: { spawn: "hook.mjs" } },
  });
  write(join(src, "cap", "inject.md"), "## Fixture capability\n\nInjected.\n");
  write(join(src, "cap", "skills", "fx", "SKILL.md"), "---\nname: fx\ndescription: fixture skill\n---\n# fx\n");
  write(join(src, "cap", "hook.mjs"), "console.log(JSON.stringify({ meta: { probe: true } }));\n");
  gitify(src);
  // 1. acquire + lock
  const r = acquirePackage(ws, src);
  assert.equal(r.root, "fx.p");
  // 2. trust the executable surface (hook)
  approveCapability(ws, "fx.cap");
  // 3. activation resolves through config with trust approved
  const resolved = resolveOasConfig(ws);
  const cap = resolved.capabilities.find((c) => c.id === "fx.cap");
  assert.ok(cap, "capability active");
  assert.equal(cap.trust.trusted, true);
  assert.ok(cap.inject.endsWith("inject.md"));
  assert.equal(cap.skills.length, 1);
  assert.ok(Object.keys(cap.hooks).includes("spawn"));
  // 4. spawn probe: scaffold an instance whose composition includes the capability
  const repo = join(ws, "repo");
  write(join(repo, "README.md"), "r\n");
  gitify(repo);
  const root = join(ws, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# Dev soul\n");
  symlinkSync("AGENTS.md", join(root, "dev", "soul", "CLAUDE.md"));
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  const agent = findAgent(root, "dev");
  const res = spawnInstance(root, agent, { launch: false });
  const composed = readFileSync(join(res.home, "AGENTS.md"), "utf8");
  assert.match(composed, /Fixture capability/);
  assert.ok(existsSync(join(res.home, ".agents", "skills", "fx", "SKILL.md")), "package capability skill composed into the instance");
  const meta = JSON.parse(readFileSync(join(res.home, "instance.json"), "utf8"));
  assert.equal(meta.capabilityMeta?.["fx.cap"]?.probe, true, "trusted package hook ran at spawn");
  rmSync(base, { recursive: true, force: true });
});

// ---------- lock semantic validation (invalid-lock) ----------

test("validateLockEntry: trust subset, dependency refs, source/commit pairing", () => {
  const ok = { source: "git:https://h/x.git@v1", path: ".", version: "1", commit: "a".repeat(40), integrity: `sha256-${"0".repeat(64)}`, capabilities: ["a.c"], dependencies: [], trustedCapabilities: ["a.c"] };
  assert.equal(validateLockEntry("p", ok, { p: ok }), true);
  assert.throws(() => validateLockEntry("p", { ...ok, trustedCapabilities: ["ghost"] }, {}), (e) => e.code === "invalid-lock");
  assert.throws(() => validateLockEntry("p", { ...ok, dependencies: ["missing.dep"] }, {}), (e) => e.code === "invalid-lock");
  assert.throws(() => validateLockEntry("p", { ...ok, commit: "shorty" }, {}), (e) => e.code === "invalid-lock");
  assert.throws(() => validateLockEntry("p", { ...ok, source: "path:/x" }, {}), (e) => e.code === "invalid-lock"); // path needs commit "local"
  assert.equal(validateLockEntry("p", { ...ok, source: "path:/x", commit: "local" }, {}), true);
  assert.throws(() => validateLockEntry("p", { ...ok, integrity: "sha256-xyz" } /* malformed on purpose */, {}), (e) => e.code === "invalid-lock");
});

test("restore and trust reject semantically invalid v2 locks with invalid-lock", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "il.p" }, { "cap": { capability: "il.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  acquirePackage(s, src);
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["il.p"].trustedCapabilities = ["not.exported"];
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  // fail-closed: restore RAISES the typed error (report-and-continue was
  // rejected by reviewer-f832ba9); approval also raises
  assert.throws(() => restorePackages(s), (e) => e.code === "invalid-lock");
  assert.throws(() => approveCapability(s, "il.cap"), (e) => e.code === "invalid-lock");
  rmSync(base, { recursive: true, force: true });
});

// ---------- package-runtime API v1 (docs/design/package-runtime-api.md) ----------

test("runtime API: Desktop probe payload unchanged (no packageRuntimeApi field)", () => {
  const r = cli(process.cwd(), "version", "--json");
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.desktopApi, 1);
  assert.equal("packageRuntimeApi" in doc, false, "boundary is versioned by compatibility floor + pinned consumer fixture, not the Desktop probe");
});

test("runtime API consumer fixture: capability-defined harvester spawned through oas spawn --json; settings via dispatch", () => {
  const base = temp();
  // deployment: workspace whose config activates a capability that DEFINES the
  // service agent and declares a command + settings (the oas.okf pattern).
  const ws = join(base, "ws");
  const repo = join(ws, "repo");
  write(join(repo, "README.md"), "r\n");
  const capDir = join(repo, ".agents", "capabilities", "owned", "fixture-svc");
  write(join(capDir, "oas.json"), JSON.stringify({
    capability: "fx.svc", version: "1.0.0", description: "fixture service", command: "fxsvc",
    agents: ["agents/memory-harvest"], commands: { settings: "bin/settings.mjs", harvest: "bin/harvest.mjs" },
  }));
  write(join(capDir, "agents", "memory-harvest", "soul.yaml"), "name: memory-harvest\nkind: capability\nwork: attached\nruntime: pi\n");
  write(join(capDir, "agents", "memory-harvest", "AGENTS.md"), "# Memory harvester\n\nHarvest notes.\n");
  write(join(capDir, "bin", "settings.mjs"), "console.log(JSON.stringify({ ok: true, settings: JSON.parse(process.env.OAS_SETTINGS || \"{}\") }));\n");
  // Consumer-fidelity command (the ruled pattern end-to-end): reads OAS_SETTINGS,
  // writes a 0600 task tempfile, execFiles the CLI at OAS_CLI_BIN (never PATH),
  // parses the one spawn envelope, re-emits ITS OWN single envelope, removes the
  // tempfile in finally.
  write(join(capDir, "bin", "harvest.mjs"), `
import { execFileSync } from "node:child_process";
import { writeFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const settings = JSON.parse(process.env.OAS_SETTINGS || "{}");
const bin = process.env.OAS_CLI_BIN;
const taskFile = join(tmpdir(), \`fx-task-\${process.pid}.md\`);
let result;
try {
  if (!bin) throw new Error("no OAS_CLI_BIN");
  writeFileSync(taskFile, "# Harvest\\n\\nprobe\\n", { mode: 0o600 });
  const mode = statSync(taskFile).mode & 0o777;
  const argv = JSON.parse(process.env.FX_SPAWN_ARGS); // test-provided flags (owner/work-dir)
  const out = execFileSync(bin, ["spawn", "memory-harvest", "--task-file", taskFile, "--json", ...argv, ...(settings["harvest-model"] ? ["--model", settings["harvest-model"]] : [])], { encoding: "utf8" }); // execFile the EXACT path — shebang/executable contract exercised
  const env = JSON.parse(out); // one spawn envelope
  result = { ok: env.ok, instance: env.result?.instance || null, model: env.result?.model || null, taskFileMode: mode.toString(8) };
} catch (e) {
  result = { ok: false, error: String(e.message || e) };
} finally {
  try { unlinkSync(taskFile); } catch {}
  result.taskFileRemoved = !existsSync(taskFile);
}
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
`);
  write(join(repo, "oas-config.yaml"), "name: fixture\ncapabilities:\n  additive:\n    fx.svc:\n      global:\n        enabled: true\n        settings:\n          harvest-model: test-model-1\n");
  gitify(repo);
  const root = join(ws, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# Dev\n");
  symlinkSync("AGENTS.md", join(root, "dev", "soul", "CLAUDE.md"));
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  const owner = spawnInstance(root, findAgent(root, "dev"), { launch: false });
  // 1. settings arrive via dispatch as OAS_SETTINGS (no public config-read command)
  let r = spawnSync(process.execPath, [CLI, "fxsvc", "settings"], { cwd: repo, encoding: "utf8", env: { ...process.env, PI_AGENT_HOME: "", OAS_HOME: "" } });
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.settings["harvest-model"], "test-model-1", "dispatched command reads effective settings from OAS_SETTINGS");
  // 2. FULL consumer fidelity: the capability's own command execFiles OAS_CLI_BIN
  //    (never PATH), writes a 0600 task file, spawns via --purpose naming, parses
  //    the one envelope, re-emits its own envelope, and cleans up in finally —
  //    with a malicious earlier-PATH oas planted to prove no PATH resolution.
  const evil = join(base, "evilbin");
  write(join(evil, "oas"), "#!/bin/sh\necho INTERCEPTED; exit 99\n");
  execFileSync("chmod", ["+x", join(evil, "oas")]);
  const spawnArgs = JSON.stringify(["--purpose", "fixture", "--repo", repo, "--parent", owner.instance, "--work", "attached", "--work-dir", join(owner.home, "work"), "--no-launch", "--dir", repo]);
  r = spawnSync(process.execPath, [CLI, "fxsvc", "harvest"], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${evil}:${process.env.PATH}`, FX_SPAWN_ARGS: spawnArgs, PI_AGENT_HOME: "", OAS_HOME: "" } });
  const henvLines = r.stdout.trim().split("\n").filter(Boolean);
  assert.equal(henvLines.length, 1, `exactly ONE envelope line on consumer stdout, got: ${r.stdout}`);
  const henv = JSON.parse(henvLines[0]); // consumer's ONE envelope
  assert.equal(henv.ok, true, r.stdout + r.stderr);
  assert.equal(henv.instance, "memory-harvest-fixture", "purpose-derived deterministic naming through the consumer");
  assert.equal(henv.model, "test-model-1", "OAS_SETTINGS model reached the spawn");
  assert.equal(henv.taskFileMode, "600", "task tempfile created 0600");
  assert.equal(henv.taskFileRemoved, true, "task tempfile removed in finally");
  assert.ok(!r.stdout.includes("INTERCEPTED"), "PATH-shadowed oas never executed");
  const meta = JSON.parse(readFileSync(join(installedHomeOf(root, "memory-harvest-fixture"), "instance.json"), "utf8"));
  assert.equal(meta.kind, "capability", "capability-defined agent is ephemeral without any override flag");
  assert.equal(meta.parentInstance, owner.instance);
  // 3. no dropped public surfaces: agent/config are not kernel commands
  // ADAPTED for the merged CLI: `agent` stays unknown, but `config` IS a
  // kernel command here (WS2's `oas config diff`) — an unknown subcommand is
  // a usage error, still one envelope.
  {
    const rr = cli(repo, "agent", "show", "memory-harvest", "--dir", repo, "--json");
    const e = JSON.parse(rr.stdout);
    assert.equal(e.ok, false);
    assert.equal(e.error.code, "E_UNKNOWN_COMMAND");
  }
  {
    const rr = cli(repo, "config", "get", "name", "--dir", repo, "--json");
    const e = JSON.parse(rr.stdout);
    assert.equal(e.ok, false);
    assert.equal(e.error.code, "E_USAGE");
  }
  // 4. retired flags fail LOUDLY with E_BAD_ARGS and no side effects
  for (const retired of ["--instance", "--ephemeral"]) {
    const rr = cli(repo, "spawn", "memory-harvest", retired, "x", "--no-launch", "--dir", repo, "--json");
    const e = JSON.parse(rr.stdout);
    assert.equal(e.ok, false, retired);
    assert.equal(e.error.code, "E_BAD_ARGS");
    assert.match(e.error.message, /removed by the runtime-boundary ruling/);
  }
  rmSync(base, { recursive: true, force: true });
});
function installedHomeOf(root, instance) {
  // capability-defined agents home under <workspace>/local-agents/<agent>/instances/<instance>
  return join(dirname(root), "local-agents", "memory-harvest", "instances", instance);
}

test("materializePackageDeps: per-capability lock placement — deps land beside the inner manifest, integrity unchanged", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "aw.p" }, { "capabilities/aweb": { capability: "aw.cap" } });
  // per-capability dependency lock (empty closure; npm ci creates node_modules)
  write(join(src, "capabilities/aweb", "package.json"), JSON.stringify({ name: "aw-cap", version: "1.0.0", scripts: { postinstall: `node -e "require('fs').writeFileSync('PWNED','x')"` } }));
  write(join(src, "capabilities/aweb", "package-lock.json"), JSON.stringify({ name: "aw-cap", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "aw-cap", version: "1.0.0" } } }));
  const before = packageIntegrity(src);
  // root selection: the per-capability dir is a materialization root
  const rep = materializePackageDeps(src);
  assert.deepEqual(rep.roots.map((r) => realpathSync(r)), [realpathSync(join(src, "capabilities/aweb"))], "per-capability lock detected as its own npm ci root");
  assert.equal(rep.error, undefined);
  acquirePackage(s, src);
  const dest = join(installedPackagesDir(s), "aw.p");
  assert.ok(!existsSync(join(dest, "capabilities/aweb", "PWNED")), "postinstall suppressed in per-capability materialization");
  assert.equal(readPackageLocks(s).packages["aw.p"].integrity, before, "nested node_modules excluded from integrity");
  rmSync(base, { recursive: true, force: true });
});

test("flat single-capability package: capabilities: [\".\"] — acquire/discover/trust/restore; \".\" exclusive with other paths", () => {
  const base = temp();
  const s = scope(base);
  const src = join(base, "flat");
  write(join(src, "oas.json"), JSON.stringify({ capability: "flat.cap", version: "1.0.0", description: "c", commands: { go: { exec: "go.mjs" } } }));
  write(join(src, "go.mjs"), "//\n");
  write(join(src, "oas-package.json"), JSON.stringify({ package: "flat.p", version: "1.0.0", description: "p", compatibility: { oas: ">=0.1.0" }, capabilities: ["."] }));
  gitify(src);
  acquirePackage(s, `file://${src}#.`);
  const m = capabilityManifests(s)["flat.cap"];
  assert.ok(m, "flat capability discovered");
  assert.equal(m._dir, m._packageDir, "capability dir IS the package root");
  approveCapability(s, "flat.cap");
  assert.equal(capabilityTrust(capabilityManifests(s)["flat.cap"], s).trusted, true);
  // restore round-trip at exact integrity
  rmSync(join(installedPackagesDir(s), "flat.p"), { recursive: true, force: true });
  const rep = restorePackages(s);
  assert.equal(rep.find((r) => r.package === "flat.p").status, "restored");
  // "." combined with another capability path is rejected
  const bad = join(base, "bad");
  write(join(bad, "oas.json"), JSON.stringify({ capability: "b.cap", version: "1", description: "c" }));
  write(join(bad, "sub", "oas.json"), JSON.stringify({ capability: "b.sub", version: "1", description: "c" }));
  write(join(bad, "oas-package.json"), JSON.stringify({ package: "b.p", version: "1", description: "p", compatibility: { oas: ">=0.1.0" }, capabilities: [".", "sub"] }));
  assert.throws(() => loadPackageManifestAt(bad), (e) => e.code === "invalid-package-manifest" && /must be the only entry/.test(e.message));
  rmSync(base, { recursive: true, force: true });
});

// ---------- residue constraints (maintainer ruling, addendum §6) ----------

test("residue: later successful conversion — re-running migrate converts once the catalog can map", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "late.cap", { source: "marketplace:late.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  // first migrate: not in catalog → residue
  let r = applyLegacyLockMigration(s, { catalog: () => undefined });
  assert.deepEqual(r.residue, ["late.cap"]);
  assert.equal(JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8")).lockfileVersion, 2);
  // official package publishes
  const official = pkgSource(join(base, "official"), { package: "late.cap" }, { "cap": { capability: "late.cap" } });
  gitify(official);
  const catalog = (id) => (id === "late.cap" ? { url: official, path: "." } : undefined);
  // second migrate on the (now v2) lock: converts the residue
  const r2 = applyLegacyLockMigration(s, { catalog });
  assert.deepEqual(r2.migrated.map((m) => m.capability), ["late.cap"]);
  assert.deepEqual(r2.residue, []);
  const parsed2 = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.ok(parsed2.packages["late.cap"]);
  assert.equal(Object.keys(parsed2.capabilities || {}).length, 0, "residue cleared after conversion");
  rmSync(base, { recursive: true, force: true });
});

test("residue: collision failure — installing a package exporting a residue capability ID errors with provenance", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "col.cap", { source: "marketplace:col.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  applyLegacyLockMigration(s, { catalog: () => undefined }); // flips to v2 with residue
  const p = pkgSource(join(base, "p"), { package: "other.p" }, { "cap": { capability: "col.cap" } });
  assert.throws(() => acquirePackage(s, p), (e) => e.code === "duplicate-capability-id" && Array.isArray(e.provenance) && e.provenance.some((x) => String(x).startsWith("residue:")));
  rmSync(base, { recursive: true, force: true });
});

test("residue: v2 locks reject NEW legacy entries — only existing residue may be updated", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "old.cap", { source: "marketplace:old.cap@1", version: "1", integrity: `sha256-${"a".repeat(64)}` });
  applyLegacyLockMigration(s, { catalog: () => undefined });
  // updating the existing residue entry is allowed (legacy restore/trust path)
  writeCapabilityLock(s, "old.cap", { source: "marketplace:old.cap@1", version: "1", integrity: `sha256-${"a".repeat(64)}`, trustedExecutables: true });
  assert.equal(JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8")).lockfileVersion, 2);
  // synthesizing a NEW legacy entry in a v2 lock is refused
  assert.throws(() => writeCapabilityLock(s, "new.cap", { source: "path:/x", version: "1", integrity: `sha256-${"b".repeat(64)}` }), (e) => e.code === "legacy-lock");
  rmSync(base, { recursive: true, force: true });
});

test("residue: migration failure is atomic — original v1 lock restored, migration-installed packages removed", () => {
  const base = temp();
  const s = scope(base);
  // two mappable entries; the second one's package does NOT export the expected capability → conversion fails
  const good = pkgSource(join(base, "good"), { package: "ok.cap" }, { "cap": { capability: "ok.cap" } });
  gitify(good);
  const wrong = pkgSource(join(base, "wrong"), { package: "bad.cap" }, { "cap": { capability: "something.else" } });
  gitify(wrong);
  writeCapabilityLock(s, "ok.cap", { source: "marketplace:ok.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  writeCapabilityLock(s, "bad.cap", { source: "marketplace:bad.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"b".repeat(64)}` });
  const original = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const catalog = (id) => (id === "ok.cap" ? { url: good, path: "." } : id === "bad.cap" ? { url: wrong, path: "." } : undefined);
  assert.throws(() => applyLegacyLockMigration(s, { catalog }), (e) => /rolled back/.test(e.message));
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), original, "original v1 lock byte-identical");
  assert.ok(!existsSync(join(installedPackagesDir(s), "ok.cap")), "migration-installed package removed on rollback");
  rmSync(base, { recursive: true, force: true });
});

test("residue: doctor --json lists each residue entry as pending-migration with a retry action", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "res.cap", { source: "marketplace:res.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  applyLegacyLockMigration(s, { catalog: () => undefined });
  const r = cli(s, "doctor", s, "--json");
  const doc = JSON.parse(r.stdout);
  const entry = doc.migrationResidue.find((e) => e.id === "res.cap");
  assert.ok(entry, "residue entry present in doctor JSON");
  assert.equal(entry.status, "pending-migration");
  assert.match(entry.action, /oas migrate/);
  // human doctor names the retry action too
  const rh = cli(s, "doctor", s);
  assert.match(rh.stdout, /res\.cap .*legacy migration residue/);
  assert.match(rh.stdout, /re-run `oas migrate/);
  rmSync(base, { recursive: true, force: true });
});

test("npm closure: dev+peer omitted from the materialized tree; prod deps present (maintainer ruling)", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "peer.p" }, { "cap": { capability: "peer.cap" } });
  // vendored prod dep (offline-installable) + a peer entry that must NOT materialize
  write(join(src, "vendor/prod-pkg/package.json"), JSON.stringify({ name: "prod-pkg", version: "1.0.0" }));
  write(join(src, "package.json"), JSON.stringify({ name: "peer-p", version: "1.0.0", dependencies: { "prod-pkg": "file:vendor/prod-pkg" }, peerDependencies: { "left-pad": "*" } }));
  // lockfile shaped like `npm install --package-lock-only` output: peer entry present in METADATA
  write(join(src, "package-lock.json"), JSON.stringify({
    name: "peer-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "peer-p", version: "1.0.0", dependencies: { "prod-pkg": "file:vendor/prod-pkg" }, peerDependencies: { "left-pad": "*" } },
      "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==", peer: true },
      "node_modules/prod-pkg": { resolved: "vendor/prod-pkg", link: true },
      "vendor/prod-pkg": { version: "1.0.0" },
    },
  }));
  acquirePackage(s, src);
  const dest = join(installedPackagesDir(s), "peer.p");
  assert.ok(existsSync(join(dest, "node_modules", "prod-pkg")), "production dependency materialized");
  assert.ok(!existsSync(join(dest, "node_modules", "left-pad")), "peer dependency in lock METADATA is absent from the materialized tree");
  rmSync(base, { recursive: true, force: true });
});

// ---------- kernel oas-packages skill + agent-callable CLI completeness ----------

test("kernel skill oas-packages is composed into every instance", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: t\n");
  const repo = join(ws, "repo");
  write(join(repo, "README.md"), "r\n");
  gitify(repo);
  const root = join(ws, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# Dev\n");
  symlinkSync("AGENTS.md", join(root, "dev", "soul", "CLAUDE.md"));
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  const r = spawnInstance(root, findAgent(root, "dev"), { launch: false });
  assert.ok(existsSync(join(r.home, ".agents", "skills", "oas-packages", "SKILL.md")), "oas-packages kernel skill materialized");
  const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
  assert.ok(meta.skills.some((s) => s.name === "oas-packages" && s.source === "kernel"));
  rmSync(base, { recursive: true, force: true });
});

test("agent-callable JSON completeness: install/restore/trust/update/remove/migrate all emit one envelope with taxonomy codes", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "js.p" }, { "cap": { capability: "js.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  gitify(src);
  // install --json
  let env = JSON.parse(cli(s, "install", `file://${src}#.`, "--dir", s, "--json").stdout);
  assert.equal(env.ok, true);
  assert.equal(env.result.root, "js.p");
  assert.equal(env.result.installed[0].package, "js.p");
  // trust --json (per-capability)
  env = JSON.parse(cli(s, "trust", "js.cap", "--dir", s, "--json").stdout);
  assert.equal(env.ok, true);
  assert.deepEqual(env.result.approved, ["js.cap"]);
  // bare install (restore) --json — WS2's approved reconcile envelope
  // (boundary/scopes/artifacts) carries the engine's per-package rows as
  // artifacts with kind "package".
  rmSync(join(installedPackagesDir(s), "js.p"), { recursive: true, force: true });
  env = JSON.parse(cli(s, "install", "--dir", s, "--json").stdout);
  assert.equal(env.ok, true);
  {
    const arts = env.result.scopes.flatMap((sc) => sc.artifacts);
    assert.equal(arts.find((a) => a.id === "js.p" && a.kind === "package").status, "restored");
  }
  // update --json (unchanged)
  env = JSON.parse(cli(s, "update", "js.p", "--dir", s, "--json").stdout);
  assert.equal(env.ok, true);
  assert.equal(env.result.changed, false);
  // migrate --dry-run --json
  env = JSON.parse(cli(s, "migrate", "--dry-run", "--dir", s, "--json").stdout);
  assert.equal(env.ok, true);
  assert.deepEqual(env.result.plan, []);
  // remove --json failure carries a taxonomy code (unknown package)
  let r = cli(s, "remove", "ghost.p", "--dir", s, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "unknown-capability");
  assert.notEqual(r.status, 0);
  // remove --json success
  env = JSON.parse(cli(s, "remove", "js.p", "--dir", s, "--json").stdout);
  assert.equal(env.ok, true);
  assert.equal(env.result.package, "js.p");
  // trust --json failure: integrity drift carries the frozen code
  cli(s, "install", `file://${src}#.`, "--dir", s);
  write(join(installedPackagesDir(s), "js.p", "cap", "r.mjs"), "// tampered\n");
  env = JSON.parse(cli(s, "trust", "js.cap", "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "integrity-drift");
  rmSync(base, { recursive: true, force: true });
});

// ---------- maintainer ruling: required compatibility + hardened invalid-lock ----------

test("compatibility: required, exact v1 grammar; malformed/missing → invalid-package-manifest; unsatisfied → incompatible-oas", () => {
  const base = temp();
  const mk = (compat) => {
    const d = join(base, `c${Math.random().toString(36).slice(2)}`);
    write(join(d, "oas-package.json"), JSON.stringify({ package: "c.p", version: "1.0.0", description: "d", ...(compat === null ? {} : { compatibility: compat }) }));
    return d;
  };
  // three accepted forms
  for (const oas of [">=0.1.0", "^0.1.0", "0.1.0"]) loadPackageManifestAt(mk({ oas }));
  // missing
  assert.throws(() => loadPackageManifestAt(mk(null)), (e) => e.code === "invalid-package-manifest" && /requires "compatibility"/.test(e.message));
  // malformed / unsupported operator
  for (const oas of ["banana", ">=1.2", "~1.2.3", "1.2.x", ">= 1.2.3"]) {
    assert.throws(() => loadPackageManifestAt(mk({ oas })), (e) => e.code === "invalid-package-manifest" && /malformed/.test(e.message), oas);
  }
  // valid but unsatisfied range → incompatible-oas at acquire
  const un = mk({ oas: ">=999.0.0" });
  assert.throws(() => acquirePackage(scope(base), un), (e) => e.code === "incompatible-oas");
  rmSync(base, { recursive: true, force: true });
});

test("invalid-lock hardening: self-dependency, locked-graph cycle, duplicates, provenance fields", () => {
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  const mkEntry = (over = {}) => ({ source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: ["x.c"], dependencies: [], trustedCapabilities: [], ...over });
  // self-dependency
  assert.throws(() => validateLockEntry("p", mkEntry({ dependencies: ["p"] }), { p: mkEntry() }, { file: "/f" }),
    (e) => e.code === "invalid-lock" && /self-dependency/.test(e.message) && e.provenance?.[0]?.package === "p" && e.provenance?.[0]?.file === "/f");
  // cycle across the locked graph: a → b → a
  const a = mkEntry({ dependencies: ["b"] });
  const b = mkEntry({ dependencies: ["a"], capabilities: ["y.c"] });
  assert.throws(() => validateLockEntry("a", a, { a, b }, {}), (e) => e.code === "invalid-lock" && /cycle/.test(e.message));
  // duplicates in arrays
  assert.throws(() => validateLockEntry("p", mkEntry({ capabilities: ["x.c", "x.c"] }), {}, {}), (e) => /duplicates/.test(e.message));
  // plausible-but-invalid pairing: catalog source with "local" commit
  assert.throws(() => validateLockEntry("p", mkEntry({ source: "catalog:oas.x@v1", commit: "local" }), {}, {}), (e) => e.code === "invalid-lock" && /40-hex/.test(e.message));
  rmSync; // no fs in this test
});

test("invalid-lock: update/remove planning fail closed; doctor and list diagnose without crashing", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "hd.p" }, { "cap": { capability: "hd.cap" } });
  gitify(src);
  cli(s, "install", `file://${src}#.`, "--dir", s);
  // corrupt the lock: trust outside capabilities
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["hd.p"].trustedCapabilities = ["ghost.cap"];
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  // update and remove planning fail closed with invalid-lock
  assert.throws(() => updatePackage(s, "hd.p"), (e) => e.code === "invalid-lock");
  assert.throws(() => removePackage(s, "hd.p"), (e) => e.code === "invalid-lock");
  // list FAILS CLOSED (maintainer finding 3): raises typed invalid-lock via the envelope
  let r = cli(s, "list", "--dir", s, "--json");
  let env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock");
  assert.match(env.error.message, /trustedCapabilities/);
  assert.notEqual(r.status, 0);
  // doctor CATCHES the typed error and diagnoses actionably without crashing
  r = cli(s, "doctor", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[invalid-lock\]/);
  assert.match(r.stdout, /never auto-repaired/);
  rmSync(base, { recursive: true, force: true });
});

test("invalid-lock: malformed mixed-v2 residue is diagnosed, never repaired, never trusted", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "mal.cap", { source: "marketplace:mal.cap@1", version: "1", integrity: `sha256-${"a".repeat(64)}` });
  applyLegacyLockMigration(s, { catalog: () => undefined });
  // corrupt the residue entry: strip source+integrity
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.capabilities["mal.cap"] = { version: "1" };
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  const before = readFileSync(lockFile, "utf8");
  const r = cli(s, "doctor", s);
  assert.match(r.stdout, /legacy entry "mal\.cap" is malformed .* \[invalid-lock\]/);
  assert.equal(readFileSync(lockFile, "utf8"), before, "doctor never repairs the lock");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-d64af2e blocker fixes ----------

test("trust binds the materialized dependency closure: tampering node_modules invalidates approval", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "nm.p" }, { "cap": { capability: "nm.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  write(join(src, "vendor/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(src, "vendor/dep/index.js"), "module.exports = 1;\n");
  write(join(src, "package.json"), JSON.stringify({ name: "nm-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(src, "package-lock.json"), JSON.stringify({
    name: "nm-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "nm-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }, "node_modules/dep": { resolved: "vendor/dep", link: true }, "vendor/dep": { version: "1.0.0" } },
  }));
  acquirePackage(s, src);
  const lock = readPackageLocks(s).packages["nm.p"];
  assert.match(lock.depsIntegrity, /^sha256-/, "materialized closure digest locked");
  approveCapability(s, "nm.cap");
  assert.equal(capabilityTrust(s, "nm.cap").trusted, true);
  // tamper the materialized closure with a planted file — only the deps digest
  // sees it (packageIntegrity excludes node_modules entirely)
  const dest = join(installedPackagesDir(s), "nm.p");
  write(join(dest, "node_modules", "evil.js"), "module.exports = 666; // planted\n");
  const t = capabilityTrust(s, "nm.cap");
  assert.equal(t.trusted, false);
  assert.match(t.reason, /dependency/);
  assert.throws(() => approveCapability(s, "nm.cap"), (e) => e.code === "integrity-drift");
  // restore re-materializes and verifies the digest
  rmSync(dest, { recursive: true, force: true });
  const rep = restorePackages(s);
  assert.equal(rep.find((r) => r.package === "nm.p").status, "restored");
  assert.equal(capabilityTrust(s, "nm.cap").trusted, true, "approval survives restore at identical source+deps digests");
  rmSync(base, { recursive: true, force: true });
});

test("contract signature: capabilityTrust(startDir, capabilityId) returns package/integrity/executableSurface", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "sig.p" }, { "cap": { capability: "sig.cap", commands: { go: { exec: "g.mjs" } }, hooks: { spawn: "h.mjs" } } });
  write(join(src, "cap", "g.mjs"), "//\n");
  write(join(src, "cap", "h.mjs"), "//\n");
  acquirePackage(s, src);
  const t = capabilityTrust(s, "sig.cap");
  assert.equal(t.trusted, false);
  assert.equal(t.package, "sig.p");
  assert.deepEqual(t.executableSurface, { commands: ["go"], hooks: ["spawn"] });
  approveCapability(s, "sig.cap");
  const t2 = capabilityTrust(s, "sig.cap");
  assert.equal(t2.trusted, true);
  assert.match(t2.integrity, /^sha256-/);
  // legacy shape still works
  assert.equal(capabilityTrust(capabilityManifests(s)["sig.cap"], s).trusted, true);
  rmSync(base, { recursive: true, force: true });
});

test("acquire transaction: failed materialization aborts with nothing installed or locked", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "fx.p" }, { "cap": { capability: "fx2.cap" } });
  // package.json/lockfile MISMATCH → npm ci fails deterministically offline
  write(join(src, "package.json"), JSON.stringify({ name: "fx-p", version: "1.0.0", dependencies: { "some-dep": "^9.9.9" } }));
  write(join(src, "package-lock.json"), JSON.stringify({ name: "fx-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fx-p", version: "1.0.0" } } }));
  assert.throws(() => acquirePackage(s, src), (e) => /materialization failed/.test(e.message));
  assert.ok(!existsSync(join(installedPackagesDir(s), "fx.p")), "nothing installed");
  const lockFile = join(s, OAS_LOCK_FILE);
  assert.ok(!existsSync(lockFile) || !JSON.parse(readFileSync(lockFile, "utf8")).packages?.["fx.p"], "nothing locked");
  rmSync(base, { recursive: true, force: true });
});

test("update transaction: identity change fails PRE-COMMIT — nothing installed under the new identity", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "old.id" }, { "cap": { capability: "oi.cap" } });
  gitify(src);
  acquirePackage(s, `file://${src}#.`);
  // Source renames its ROOT identity while a dependency claims the expected
  // old id. Closure-membership is insufficient: update must require rootId.
  const impostorDep = pkgSource(join(base, "impostor-dep"), { package: "old.id" });
  const depCommit = gitify(impostorDep);
  write(join(src, "oas-package.json"), JSON.stringify({ package: "new.id", version: "2.0.0", description: "p", compatibility: { oas: ">=0.1.0" }, capabilities: ["cap"], dependencies: [`file://${impostorDep}@${depCommit}#.`] }));
  gitCommit(src);
  assert.throws(() => updatePackage(s, "old.id"), (e) => e.code === "duplicate-package-identity" && /root resolved/.test(e.message));
  assert.ok(!existsSync(join(installedPackagesDir(s), "new.id")), "new identity NOT installed");
  assert.equal(readPackageLocks(s).packages["new.id"], undefined, "new identity NOT locked");
  assert.equal(readPackageLocks(s).packages["old.id"].version, "1.0.0", "old lock intact");
  rmSync(base, { recursive: true, force: true });
});

test("manifest schema semantics: numeric version/description, extra profile keys, duplicate dependencies rejected", () => {
  const base = temp();
  const mk = (m) => { const d = join(base, `m${Math.random().toString(36).slice(2)}`); write(join(d, "oas-package.json"), JSON.stringify({ package: "sv.p", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, ...m })); return d; };
  assert.throws(() => loadPackageManifestAt(mk({ version: 1 })), (e) => /string version/.test(e.message));
  assert.throws(() => loadPackageManifestAt(mk({ description: 42 })), (e) => /string version and description/.test(e.message));
  assert.throws(() => loadPackageManifestAt(mk({ compatibility: { oas: ">=0.1.0", extra: true } })), (e) => /"compatibility" has unknown keys/.test(e.message));
  const withProfile = mk({ configs: { a: { path: "a.yaml", bogus: 1 } } });
  write(join(withProfile, "a.yaml"), "x\n");
  assert.throws(() => loadPackageManifestAt(withProfile), (e) => /unknown keys: bogus/.test(e.message));
  assert.throws(() => loadPackageManifestAt(mk({ dependencies: ["dup.spec", "dup.spec"] })), (e) => /"dependencies" contains duplicates/.test(e.message));
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-526dc31 live findings (3–5; 1–2 moot post-redesign) ----------

test("trust QUERY path validates the lock: malformed trustedCapabilities reads as invalid-lock, never trusted", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "tq.p" }, { "cap": { capability: "tq.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  acquirePackage(s, src);
  approveCapability(s, "tq.cap");
  // corrupt: capabilities emptied while trust retains the executable capability
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["tq.p"].capabilities = [];
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  // fail-closed RAISE (reviewer-f832ba9 strengthened the earlier degrade-to-untrusted)
  assert.throws(() => capabilityTrust(s, "tq.cap"), (e) => e.code === "invalid-lock");
  rmSync(base, { recursive: true, force: true });
});

test("validateLockEntry: prototype-named dependency, non-array fields, unknown source scheme all fail invalid-lock", () => {
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  const mk = (over = {}) => ({ source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: ["x.c"], ...over });
  assert.throws(() => validateLockEntry("p", mk({ dependencies: ["constructor"] }), {}, {}), (e) => e.code === "invalid-lock" && /constructor/.test(e.message));
  assert.throws(() => validateLockEntry("p", mk({ dependencies: "notarray" }), {}, {}), (e) => e.code === "invalid-lock" && /must be an array/.test(e.message));
  assert.throws(() => validateLockEntry("p", mk({ trustedCapabilities: { evil: 1 } }), {}, {}), (e) => e.code === "invalid-lock" && /must be an array/.test(e.message));
  assert.throws(() => validateLockEntry("p", mk({ source: "weird:thing" }), {}, {}), (e) => e.code === "invalid-lock" && /unrecognized source/.test(e.message));
});

test("restore repairs a deleted node_modules closure; doctor probes closure staleness", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "rc.p" }, { "cap": { capability: "rc.cap" } });
  write(join(src, "vendor/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(src, "package.json"), JSON.stringify({ name: "rc-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(src, "package-lock.json"), JSON.stringify({ name: "rc-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "rc-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }, "node_modules/dep": { resolved: "vendor/dep", link: true }, "vendor/dep": { version: "1.0.0" } } }));
  gitify(src);
  acquirePackage(s, `file://${src}#.`);
  const dest = join(installedPackagesDir(s), "rc.p");
  assert.ok(existsSync(join(dest, "node_modules", "dep")));
  // delete the derived closure: doctor flags it; bare restore repairs it
  rmSync(join(dest, "node_modules"), { recursive: true, force: true });
  let r = cli(s, "doctor", s);
  assert.match(r.stdout, /materialized runtime closure missing/);
  const rep = restorePackages(s);
  assert.equal(rep.find((x) => x.package === "rc.p").status, "restored");
  assert.ok(existsSync(join(dest, "node_modules", "dep")), "closure re-materialized by restore");
  r = cli(s, "doctor", s);
  assert.ok(!/materialized runtime closure/.test(r.stdout), "doctor clean after repair");
  rmSync(base, { recursive: true, force: true });
});

// ---------- maintainer RETURN corrections (fda72763) + reviewer-4d1b826 blocker ----------

test("__proto__ raw-JSON lock keys cannot forge trusted entries (reviewer-4d1b826 blocker)", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "p" }, { "cap": { capability: "p.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  acquirePackage(s, src);
  const genuine = readPackageLocks(s).packages["p"];
  // craft a lock whose ONLY package key is __proto__ nesting a forged trusted entry
  const forged = { lockfileVersion: 2, packages: JSON.parse(`{"__proto__": {"p": ${JSON.stringify({ source: genuine.source, version: genuine.version, commit: genuine.commit, integrity: genuine.integrity, ...(genuine.depsIntegrity ? { depsIntegrity: genuine.depsIntegrity } : {}), capabilities: ["p.cap"], dependencies: [], trustedCapabilities: ["p.cap"] })}}}`) };
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify(forged, null, 2));
  // fail-closed read: the invalid key raises; no code path can see a forged "p" entry
  assert.throws(() => readPackageLocks(s), (e) => e.code === "invalid-lock" && /invalid package key/.test(e.message));
  // trust can only fail closed: either the typed raise (via discovery) or untrusted — never trusted:true
  let trusted;
  try { trusted = capabilityTrust(s, "p.cap").trusted; } catch (e) { assert.equal(e.code, "invalid-lock"); trusted = false; }
  assert.equal(trusted, false, "forged prototype entry must never read as trusted");
  rmSync(base, { recursive: true, force: true });
});

test("validateLockEntry: falsey non-array optional fields are invalid (null/false/0/'')", () => {
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  const mk = (over) => ({ source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: ["x.c"], ...over });
  for (const v of [null, false, 0, ""]) {
    assert.throws(() => validateLockEntry("p", mk({ dependencies: v }), {}, {}), (e) => e.code === "invalid-lock", `dependencies=${JSON.stringify(v)}`);
    assert.throws(() => validateLockEntry("p", mk({ trustedCapabilities: v }), {}, {}), (e) => e.code === "invalid-lock", `trustedCapabilities=${JSON.stringify(v)}`);
  }
  // absent stays valid; malformed depsIntegrity is invalid
  assert.equal(validateLockEntry("p", mk({}), {}, {}), true);
  assert.throws(() => validateLockEntry("p", mk({ depsIntegrity: "sha256-xyz" }), {}, {}), (e) => /depsIntegrity/.test(e.message));
});

test("dispatch passes OAS_CLI_BIN (absolute, canonical); malicious earlier-PATH oas cannot intercept (finding 1)", () => {
  const base = temp();
  const repo = join(base, "repo");
  write(join(repo, "README.md"), "r\n");
  const capDir = join(repo, ".agents", "capabilities", "owned", "clibin");
  write(join(capDir, "oas.json"), JSON.stringify({ capability: "cb.svc", version: "1.0.0", description: "d", command: "cbsvc", commands: { probe: "bin/probe.mjs" } }));
  // consumer-style probe: execFile the OAS_CLI_BIN path (never PATH), re-emit its envelope
  write(join(capDir, "bin", "probe.mjs"), `
import { execFileSync } from "node:child_process";
const bin = process.env.OAS_CLI_BIN;
if (!bin || !bin.startsWith("/")) { console.log(JSON.stringify({ ok: false, why: "no absolute OAS_CLI_BIN" })); process.exit(1); }
const out = execFileSync(bin, ["version", "--json"], { encoding: "utf8" }); // execFile the EXACT path
console.log(JSON.stringify({ ok: true, probe: JSON.parse(out) }));
`);
  write(join(repo, "oas-config.yaml"), "name: t\ncapabilities:\n  additive:\n    cb.svc:\n      global: true\n");
  gitify(repo);
  // malicious PATH: an earlier `oas` that would poison any PATH-based resolution
  const evil = join(base, "evilbin");
  write(join(evil, "oas"), "#!/bin/sh\necho INTERCEPTED; exit 99\n");
  execFileSync("chmod", ["+x", join(evil, "oas")]);
  const r = spawnSync(process.execPath, [CLI, "cbsvc", "probe"], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${evil}:${process.env.PATH}`, PI_AGENT_HOME: "", OAS_HOME: "" } });
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.ok, true, r.stdout + r.stderr);
  assert.equal(out.probe.name, "@oas-framework/oas", "consumer reached the REAL CLI via OAS_CLI_BIN");
  assert.ok(!r.stdout.includes("INTERCEPTED"), "PATH-shadowed oas never executed");
  rmSync(base, { recursive: true, force: true });
});

test("materialized symlink containment: escaping/broken node_modules links fail the transaction with rollback (finding 4)", () => {
  const base = temp();
  const s = scope(base);
  // package whose npm ci produces a node_modules symlink escaping the root:
  // file: dep pointing OUTSIDE the package root does exactly that.
  write(join(base, "outside-dep", "package.json"), JSON.stringify({ name: "outside-dep", version: "1.0.0" }));
  const src = pkgSource(join(base, "src"), { package: "sl.p" }, { "cap": { capability: "sl.cap" } });
  write(join(src, "package.json"), JSON.stringify({ name: "sl-p", version: "1.0.0", dependencies: { "outside-dep": "file:../outside-dep" } }));
  write(join(src, "package-lock.json"), JSON.stringify({
    name: "sl-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "sl-p", version: "1.0.0", dependencies: { "outside-dep": "file:../outside-dep" } }, "node_modules/outside-dep": { resolved: "../outside-dep", link: true }, "../outside-dep": { version: "1.0.0" } },
  }));
  assert.throws(() => acquirePackage(s, src), (e) => e.code === "path-escape" && /symlink/.test(e.message));
  assert.ok(!existsSync(join(installedPackagesDir(s), "sl.p")), "rollback: nothing installed");
  const lockFile = join(s, OAS_LOCK_FILE);
  assert.ok(!existsSync(lockFile) || !JSON.parse(readFileSync(lockFile, "utf8")).packages?.["sl.p"], "rollback: nothing locked");
  rmSync(base, { recursive: true, force: true });
});

test("writePackageLock validates the FULL prospective map (finding 3)", () => {
  const base = temp();
  const s = scope(base);
  const sha = "a".repeat(40);
  const integ = `sha256-${"3".repeat(64)}`;
  const good = { source: `git:https://h/x.git@v1`, path: ".", version: "1", commit: sha, integrity: integ, capabilities: ["g.c"], dependencies: [], trustedCapabilities: [] };
  writePackageLock(s, "good.p", good);
  // writing an entry that references a missing dependency is rejected...
  assert.throws(() => writePackageLock(s, "bad.p", { ...good, capabilities: ["b.c"], dependencies: ["ghost.p"] }), (e) => e.code === "invalid-lock");
  // ...and the file still contains only the valid entry
  const parsed = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.deepEqual(Object.keys(parsed.packages), ["good.p"]);
  // an invalid package identity key is rejected up front
  assert.throws(() => writePackageLock(s, "__proto__", good), (e) => e.code === "invalid-lock");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-72f06c7 findings ----------

test("migration rollback removes the FAILING conversion's packages too (reviewer-72f06c7)", () => {
  const base = temp();
  const s = scope(base);
  const good = pkgSource(join(base, "good"), { package: "ok.cap" }, { "cap": { capability: "ok.cap" } });
  gitify(good);
  // the FAILING conversion carries a DEPENDENCY — rollback must remove BOTH
  const wrongDep = pkgSource(join(base, "wrong-dep"), { package: "bad.dep" });
  const wrongDepCommit = gitify(wrongDep);
  const wrong = pkgSource(join(base, "wrong"), { package: "bad.cap", dependencies: [`file://${wrongDep}@${wrongDepCommit}#.`] }, { "cap": { capability: "something.else" } });
  gitify(wrong);
  writeCapabilityLock(s, "ok.cap", { source: "marketplace:ok.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  writeCapabilityLock(s, "bad.cap", { source: "marketplace:bad.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"b".repeat(64)}` });
  const original = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  const catalog = (id) => (id === "ok.cap" ? { url: good, path: "." } : id === "bad.cap" ? { url: wrong, path: "." } : undefined);
  assert.throws(() => applyLegacyLockMigration(s, { catalog }), /rolled back/);
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), original);
  assert.ok(!existsSync(join(installedPackagesDir(s), "ok.cap")), "earlier conversion removed");
  assert.ok(!existsSync(join(installedPackagesDir(s), "bad.cap")), "FAILING conversion's package removed too");
  assert.ok(!existsSync(join(installedPackagesDir(s), "bad.dep")), "FAILING conversion's DEPENDENCY removed too");
  rmSync(base, { recursive: true, force: true });
});

test("refused legacy install at a v2 scope leaves lock AND store unchanged (reviewer-72f06c7)", () => {
  const base = temp();
  const s = scope(base);
  // v2 scope with migration residue-capable lock
  const pkg = pkgSource(join(base, "pkg"), { package: "v2.p" }, { "cap": { capability: "v2.cap" } });
  acquirePackage(s, pkg);
  const lockBefore = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  // legacy capability source (bare oas.json, no oas-package.json)
  const legacy = join(base, "legacy-cap");
  write(join(legacy, "oas.json"), JSON.stringify({ capability: "leg.cap", version: "1.0.0", description: "d" }));
  const r = cli(s, "install", legacy, "--dir", s);
  assert.notEqual(r.status, 0, "refused");
  assert.match(r.stderr, /legacy|migrate/i);
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore, "lock unchanged");
  const capStore = join(s, ".agents", "capabilities", "installed");
  assert.ok(!existsSync(join(capStore, "legacy-cap")), "no stranded artifact in the capability store");
  // retry does NOT report already-acquired
  const r2 = cli(s, "install", legacy, "--dir", s);
  assert.notEqual(r2.status, 0);
  assert.ok(!r2.stdout.includes("Already acquired"), "retry is a clean refusal, not already-acquired");
  // init's marketplace acquisition path compensates the same way: the store
  // stays free of stranded artifacts when its lock write is refused.
  const r3 = cli(s, "init", "--dir", s, "--knowledge", "oas.okf");
  assert.notEqual(r3.status, 0, "init acquisition refused at the v2 scope");
  assert.ok(!existsSync(join(capStore, "oas-okf")), "init leaves no stranded artifact");
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore, "init leaves the lock unchanged");
  rmSync(base, { recursive: true, force: true });
});

test("residue collision blocks unrelated acquires when a RETAINED locked package exports the colliding id (reviewer-72f06c7)", () => {
  const base = temp();
  const s = scope(base);
  // pre-existing package exporting col.cap (installed BEFORE any residue exists)
  const pre = pkgSource(join(base, "pre"), { package: "pre.p" }, { "cap": { capability: "col.cap" } });
  acquirePackage(s, pre);
  // simulate a pre-stricter-commit mixed lock: residue entry colliding with the locked package
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.capabilities = { "col.cap": { source: "marketplace:col.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` } };
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  // an UNRELATED acquire must now fail with both provenances, not succeed past the dual path
  const other = pkgSource(join(base, "other"), { package: "other.p" }, { "cap": { capability: "other.cap" } });
  assert.throws(() => acquirePackage(s, other), (e) => e.code === "duplicate-capability-id"
    && e.provenance.some((x) => String(x).startsWith("residue:"))
    && e.provenance.includes("pre.p"));
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-775b060 findings: complete JSON envelope coverage ----------

test("install --json envelopes every branch: missing path, retired id, legacy success, already-acquired", () => {
  const base = temp();
  const s = scope(base);
  // missing local path → invalid-source envelope
  let env = JSON.parse(cli(s, "install", "path:/definitely/missing", "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-source");
  // retired capability id → retired-capability envelope
  env = JSON.parse(cli(s, "install", "oas.web", "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "retired-capability");
  // legacy capability success → ONE object
  const legacy = join(base, "cap");
  write(join(legacy, "oas.json"), JSON.stringify({ capability: "lj.cap", version: "1.0.0", description: "d" }));
  let r = cli(s, "install", legacy, "--dir", s, "--json");
  env = JSON.parse(r.stdout); // throws on prose contamination
  assert.equal(env.ok, true);
  assert.equal(env.result.capability, "lj.cap");
  // re-install of the same path → enveloped refusal (never silent update), not prose
  env = JSON.parse(cli(s, "install", legacy, "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-source");
  assert.match(env.error.message, /never silently updates/);
  rmSync(base, { recursive: true, force: true });
});

test("bare restore --json failure uses a frozen taxonomy code and the exact failure envelope shape", () => {
  const base = temp();
  const s = scope(base);
  // v1 lock naming a missing path source → restore failure
  writeCapabilityLock(s, "gone.cap", { source: "path:/nope/missing", version: "1", integrity: `sha256-${"a".repeat(64)}` });
  const r = cli(s, "install", "--dir", s, "--json");
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.deepEqual(Object.keys(env).sort(), ["error", "ok", "schemaVersion"], "EXACT failure shape — no extra top-level keys");
  // Maintainer-approved WS2 contract (refinement 5): bare install failures
  // aggregate under E_RECONCILE_FAILED with the COMPLETE report in
  // error.details; per-artifact rows carry the frozen taxonomy codes.
  assert.equal(env.error.code, "E_RECONCILE_FAILED");
  const failures = env.error.details.failures;
  assert.ok(failures.length >= 1);
  assert.ok(failures.some((f) => String(f.id).includes("gone.cap")), JSON.stringify(failures));
  assert.notEqual(r.status, 0);
  rmSync(base, { recursive: true, force: true });
});

test("trust/migrate --json: usage and malformed-lock failures stay enveloped", () => {
  const base = temp();
  const s = scope(base);
  // trust usage error → envelope
  let env = JSON.parse(cli(s, "trust", "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_USAGE");
  // malformed lock JSON → migrate --dry-run --json envelopes invalid-lock (no stack trace)
  writeFileSync(join(s, OAS_LOCK_FILE), "{ definitely not json");
  const r = cli(s, "migrate", "--dry-run", "--dir", s, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock");
  // trust against the malformed lock also envelopes (unknown target probes first;
  // both are one-object failures with taxonomy codes)
  env = JSON.parse(cli(s, "trust", "whatever.cap", "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.ok(["invalid-lock", "unknown-capability"].includes(env.error.code), env.error.code);
  rmSync(base, { recursive: true, force: true });
});

test("bulk trust --json prints the pre-approval surface on stderr, one object on stdout", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "bt.p" }, { "c1": { capability: "bt.a", commands: { x: { exec: "x.mjs" } } } });
  write(join(src, "c1", "x.mjs"), "//\n");
  cli(s, "install", src, "--dir", s);
  const r = cli(s, "trust", "bt.p", "--all-capabilities", "--dir", s, "--json");
  const env = JSON.parse(r.stdout); // one object
  assert.equal(env.ok, true);
  assert.match(r.stderr, /full executable surface/, "pre-approval summary on stderr in JSON mode");
  assert.match(r.stderr, /bt\.a: commands \[x\]/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-fe8053d findings (blocker fixed in 4d1b826; live importants) ----------

test("trust EXECUTION path rejects invalid lock graphs (self-dep) — regression for the fe8053d blocker fixed in 4d1b826", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "a.p" }, { "cap": { capability: "ex.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  acquirePackage(s, src);
  approveCapability(s, "ex.cap");
  // corrupt: self-dependency (the reviewer's exact repro)
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["a.p"].dependencies = ["a.p"];
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  // fail-closed RAISE on the query path (reviewer-f832ba9)
  assert.throws(() => capabilityTrust(s, "ex.cap"), (e) => e.code === "invalid-lock");
  // resolveCapabilities (the execution path) must not expose the hooks/commands
  write(join(s, "oas-config.yaml"), "name: t\ncapabilities:\n  additive:\n    ex.cap:\n      from: installed\n      global: true\n");
  assert.throws(() => resolveOasConfig(s), (e) => e.code === "invalid-lock" || /not usable|invalid/.test(e.message));
  rmSync(base, { recursive: true, force: true });
});

test("updatePackage fails closed when ANY consumable lock entry is invalid (reviewer-fe8053d)", () => {
  const base = temp();
  const s = scope(base);
  const dep = pkgSource(join(base, "dep"), { package: "b.p" }, { "cap": { capability: "b.cap" } });
  const depCommit = gitify(dep);
  const root = pkgSource(join(base, "root"), { package: "a2.p", dependencies: [`file://${dep}@${depCommit}#.`] });
  gitify(root);
  acquirePackage(s, `file://${root}#.`);
  // corrupt the DEPENDENCY entry, then update the ROOT
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["b.p"].trustedCapabilities = ["ghost"];
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  assert.throws(() => updatePackage(s, "a2.p"), (e) => e.code === "invalid-lock" && /b\.p/.test(e.message), "invalid dependency entry fails the update closure");
  rmSync(base, { recursive: true, force: true });
});

test("schema/runtime parity: array/null compatibility, empty source (reviewer-fe8053d)", () => {
  const base = temp();
  const mk = (compat) => { const d = join(base, `m${Math.random().toString(36).slice(2)}`); write(join(d, "oas-package.json"), JSON.stringify({ package: "x.p", version: "1.0.0", description: "d", compatibility: compat })); return d; };
  assert.throws(() => loadPackageManifestAt(mk({ oas: ["1.2.3"] })), (e) => e.code === "invalid-package-manifest", "array oas rejected, no coercion");
  assert.throws(() => loadPackageManifestAt(mk(null)), (e) => e.code === "invalid-package-manifest", "null compatibility is invalid-package-manifest, not TypeError");
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  assert.throws(() => validateLockEntry("p", { source: "path:", path: ".", version: "1", commit: "local", integrity: integ, capabilities: [] }, {}, {}), (e) => e.code === "invalid-lock", "empty path source rejected");
  assert.throws(() => validateLockEntry("p", { source: "git:", path: ".", version: "1", commit: sha, integrity: integ, capabilities: [] }, {}, {}), (e) => e.code === "invalid-lock", "empty git url rejected");
  rmSync(base, { recursive: true, force: true });
});

test("doctor --json diagnoses malformed residue with invalid-lock status; human/JSON agree (reviewer-fe8053d)", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "ok.res", { source: "marketplace:ok.res@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  applyLegacyLockMigration(s, { catalog: () => undefined });
  // corrupt: strip version (a field the OLD human check missed) + inject a second malformed entry
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  delete parsed.capabilities["ok.res"].version;
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  const rj = cli(s, "doctor", s, "--json");
  const doc = JSON.parse(rj.stdout);
  assert.equal(doc.error.code, "invalid-lock");
  assert.match(doc.error.message, /legacy entry "ok\.res" is malformed \(missing\/invalid version\)/);
  assert.match(JSON.stringify(doc.error.provenance), /ok\.res/);
  const rh = cli(s, "doctor", s);
  assert.match(rh.stdout, /legacy entry "ok\.res" is malformed \(missing\/invalid version\)/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- maintainer finding 2: platform-invariance enforcement ----------

test("platform-variant closures are rejected at materialization (v1 MUST, finding 2)", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "pv.p" }, { "cap": { capability: "pv.cap" } });
  // lockfile resolving a platform-constrained (native-style) package
  write(join(src, "package.json"), JSON.stringify({ name: "pv-p", version: "1.0.0", dependencies: { "fake-native": "1.0.0" } }));
  write(join(src, "package-lock.json"), JSON.stringify({
    name: "pv-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "pv-p", version: "1.0.0", dependencies: { "fake-native": "1.0.0" } },
      "node_modules/fake-native": { version: "1.0.0", resolved: "https://registry.npmjs.org/fake-native/-/fake-native-1.0.0.tgz", integrity: "sha512-AAA", os: ["darwin"], cpu: ["arm64"] },
    },
  }));
  assert.throws(() => acquirePackage(s, src), /platform-variant runtime closure.*os\/cpu\/libc/);
  assert.ok(!existsSync(join(installedPackagesDir(s), "pv.p")), "nothing installed");
  // INCLUDED install scripts are REJECTED (maintainer ruling on 19fbc86: the
  // runtime almost certainly expects the artifacts --ignore-scripts suppresses).
  const src2 = pkgSource(join(base, "src2"), { package: "pv2.p" }, { "cap": { capability: "pv2.cap" } });
  write(join(src2, "package.json"), JSON.stringify({ name: "pv2-p", version: "1.0.0", dependencies: { "gyp-dep": "1.0.0" } }));
  write(join(src2, "package-lock.json"), JSON.stringify({
    name: "pv2-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "pv2-p", version: "1.0.0", dependencies: { "gyp-dep": "1.0.0" } },
      "node_modules/gyp-dep": { version: "1.0.0", resolved: "https://registry.npmjs.org/gyp-dep/-/gyp-dep-1.0.0.tgz", integrity: "sha512-BBB", hasInstallScript: true },
    },
  }));
  assert.throws(() => acquirePackage(s, src2), /install script/);
  // pure-JS closures still pass (regression: the vendored prod-dep fixture pattern)
  const ok = pkgSource(join(base, "ok"), { package: "pi.p" }, { "cap": { capability: "pi.cap" } });
  write(join(ok, "vendor/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(ok, "package.json"), JSON.stringify({ name: "pi-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(ok, "package-lock.json"), JSON.stringify({ name: "pi-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "pi-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }, "node_modules/dep": { resolved: "vendor/dep", link: true }, "vendor/dep": { version: "1.0.0" } } }));
  const r = acquirePackage(s, ok);
  assert.equal(r.root, "pi.p");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-f832ba9 blockers ----------

test("nested materialized links cannot bypass containment: node_modules/dep → vendor/dep with an escaping inner link (reviewer-f832ba9)", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "nl.p" }, { "cap": { capability: "nl.cap" } });
  // vendored dep INSIDE the root containing a symlink that ESCAPES the root
  write(join(src, "vendor", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(base, "outside-secret"), "leak\n");
  symlinkSync(join(base, "outside-secret"), join(src, "vendor", "dep", "escape"));
  write(join(src, "package.json"), JSON.stringify({ name: "nl-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(src, "package-lock.json"), JSON.stringify({ name: "nl-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "nl-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }, "node_modules/dep": { resolved: "vendor/dep", link: true }, "vendor/dep": { version: "1.0.0" } } }));
  // npm ci creates node_modules/dep → ../vendor/dep (inside), whose CONTENT
  // holds the escaping link — reachable at runtime via node_modules/dep/escape.
  assert.throws(() => acquirePackage(s, src), (e) => e.code === "path-escape" && /escape/.test(e.message));
  assert.ok(!existsSync(join(installedPackagesDir(s), "nl.p")), "rollback: nothing installed");
  const lockFile = join(s, OAS_LOCK_FILE);
  assert.ok(!existsSync(lockFile) || !JSON.parse(readFileSync(lockFile, "utf8")).packages?.["nl.p"], "rollback: nothing locked");
  rmSync(base, { recursive: true, force: true });
});

test("locks with only missing artifacts still fail closed on list; restore raises on malformed locks (reviewer-f832ba9)", () => {
  const base = temp();
  const s = scope(base);
  // v2 lock whose ONLY entry has no installed artifact and a bad integrity
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: { "ghost.p": { source: "path:/x", path: ".", version: "1", commit: "local", integrity: "sha256-bad", capabilities: [] } } }, null, 2));
  // even without a store dir, list must RAISE — not return ok:true
  const r = cli(s, "list", "--dir", s, "--json");
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock");
  // restore raises typed invalid-lock instead of reporting-and-continuing
  assert.throws(() => restorePackages(s), (e) => e.code === "invalid-lock");
  // malformed JSON: restore raises too
  writeFileSync(join(s, OAS_LOCK_FILE), "{ nope");
  assert.throws(() => restorePackages(s), (e) => e.code === "invalid-lock");
  rmSync(base, { recursive: true, force: true });
});

test("trust query RETHROWS invalid-lock (fail closed; only doctor catches) — reviewer-f832ba9", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "rt.p" }, { "cap": { capability: "rt.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "//\n");
  acquirePackage(s, src);
  const lockFile = join(s, OAS_LOCK_FILE);
  const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
  parsed.packages["rt.p"].trustedCapabilities = ["ghost.cap"];
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2));
  // the QUERY path raises the typed error — it must not degrade to {trusted:false}
  assert.throws(() => capabilityTrust(s, "rt.cap"), (e) => e.code === "invalid-lock");
  // doctor still catches and diagnoses without crashing
  const r = cli(s, "doctor", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /invalid-lock/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- WS2-reported engine bugs (coordinator mail dd2acc27) ----------

test("hostile manifest roots: JSON null/scalar/array are invalid-package-manifest, never TypeError (WS2 bug 1)", () => {
  const base = temp();
  for (const [label, body] of [["null", "null"], ["scalar", "42"], ["string", '"x"'], ["array", "[1,2]"]]) {
    const d = join(base, `h-${label}`);
    write(join(d, "oas-package.json"), body);
    assert.throws(() => loadPackageManifestAt(d), (e) => e.code === "invalid-package-manifest" && /must be a JSON object/.test(e.message), label);
  }
  rmSync(base, { recursive: true, force: true });
});

test("relative dependency paths resolve against the DEPENDING package's root, not CWD (WS2 bug 2)", () => {
  const base = temp();
  const s = scope(base);
  // package at <base>/a depending on ./sub — must resolve <base>/a/sub regardless of CWD
  const a = join(base, "a");
  pkgSource(join(a, "sub"), { package: "sub.p" }, { "cap": { capability: "sub.cap" } });
  pkgSource(a, { package: "root.rel", dependencies: ["./sub"] }, { "cap": { capability: "root.relcap" } });
  // run acquire from a DIFFERENT cwd (the CLI always runs elsewhere)
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const prevCwd = process.cwd();
  try {
    process.chdir(elsewhere);
    const r = acquirePackage(s, a);
    assert.deepEqual(r.installed.map((p) => p.package).sort(), ["root.rel", "sub.p"]);
    assert.match(readPackageLocks(s).packages["sub.p"].source, /path:.*\/a\/sub$/, "resolved against the depending package root");
  } finally {
    process.chdir(prevCwd);
  }
  // a relative dependency declared by a NON-path (git) parent is a coded error, not CWD guessing
  const g = pkgSource(join(base, "g"), { package: "g.rel", dependencies: ["./sub"] });
  gitify(g);
  assert.throws(() => acquirePackage(scope(base, "s2"), `file://${g}#.`), (e) => e.code === "invalid-source" && /relative path/.test(e.message));
  rmSync(base, { recursive: true, force: true });
});

// ---------- empty-v1-lock ruling (maintainer, coordinator mail 9aaea2c3) ----------

test("empty v1 locks SURFACE, convert trivially, and doctor reports format migration (maintainer ruling)", () => {
  const base = temp();
  const s = scope(base);
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: {} }, null, 2));
  // 1. read: legacy includes the EMPTY v1 file with provenance
  const locks = readPackageLocks(s);
  assert.equal(locks.legacy.length, 1);
  assert.equal(locks.legacy[0].lockfileVersion, 1);
  assert.equal(Object.keys(locks.legacy[0].capabilities).length, 0);
  assert.equal(locks.legacy[0].level, s);
  // 2. dry-run reports the format conversion, not "nothing found"
  let r = cli(s, "migrate", "--dry-run", "--dir", s);
  assert.match(r.stdout, /convert-format/);
  assert.match(r.stdout, /canonical v2/);
  r = cli(s, "migrate", "--dry-run", "--dir", s, "--json");
  const env = JSON.parse(r.stdout);
  assert.equal(env.result.plan[0].action, "convert-format");
  // 3. doctor: pending LOCK-FORMAT migration, never residue
  r = cli(s, "doctor", s);
  assert.match(r.stdout, /pending lock-format migration/);
  assert.ok(!/residue/.test(r.stdout.split("pending lock-format")[0].slice(-200)), "not described as residue");
  const dj = JSON.parse(cli(s, "doctor", s, "--json").stdout);
  assert.equal(dj.legacyLockFiles.length, 1);
  assert.equal(dj.legacyLockFiles[0].empty, true);
  assert.equal(dj.legacyLockFiles[0].status, "pending-format-migration");
  assert.deepEqual(dj.migrationResidue, [], "empty v1 is NOT capability residue");
  // 4. migrate: atomic canonical v2, no residue
  r = cli(s, "migrate", "--dir", s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /converted to canonical v2/);
  const parsed = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.deepEqual(parsed, { lockfileVersion: 2, packages: {} });
  // 5. post-conversion: legacy list is empty (v2 {capabilities:{}} is NOT residue)
  assert.deepEqual(readPackageLocks(s).legacy, []);
  const dj2 = JSON.parse(cli(s, "doctor", s, "--json").stdout);
  assert.deepEqual(dj2.legacyLockFiles, []);
  rmSync(base, { recursive: true, force: true });
});

test("cutover gate probe: two-part acceptance and rejection (empty v1 blocks; nonempty residue blocks; clean passes)", () => {
  const base = temp();
  // scope A: empty v1 (blocks part a) — a lock-owning scope with NO config
  const a = join(base, "a");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: {} }));
  // discovery includes lock-owning scopes without config entries: read from a CHILD dir
  const child = join(a, "nested", "deeper");
  mkdirSync(child, { recursive: true });
  const gate = (dir) => {
    const l = readPackageLocks(dir).legacy;
    const v1Files = l.filter((x) => x.lockfileVersion !== 2);
    const residue = l.filter((x) => x.lockfileVersion === 2 && Object.keys(x.capabilities).length);
    return { pass: v1Files.length === 0 && residue.length === 0, v1Files: v1Files.length, residue: residue.length };
  };
  let g = gate(child);
  assert.equal(g.pass, false, "empty v1 blocks the cutover");
  assert.equal(g.v1Files, 1);
  // convert → passes
  cli(a, "migrate", "--dir", a);
  g = gate(child);
  assert.equal(g.pass, true, "clean two-part gate passes after conversion");
  // scope B: nonempty v2 residue blocks part b
  const b = join(base, "b");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: { "res.cap": { source: "marketplace:res.cap@1", version: "1", integrity: `sha256-${"a".repeat(64)}` } } }));
  g = gate(b);
  assert.equal(g.pass, false, "nonempty v2 residue blocks the cutover");
  assert.equal(g.residue, 1);
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-6f0a3bd findings ----------

test("bare restore reports unrestorable/retired statuses as failures with frozen codes (reviewer-6f0a3bd)", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "bogus.cap", { source: "bogus:thing", version: "1", integrity: `sha256-${"a".repeat(64)}` });
  const r = cli(s, "install", "--dir", s, "--json");
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, false, "unrestorable must not report ok");
  // WS2 reconcile envelope: aggregate code E_RECONCILE_FAILED; the per-artifact
  // row carries the frozen taxonomy code (invalid-source for unrestorable).
  assert.equal(env.error.code, "E_RECONCILE_FAILED");
  const art = env.error.details.scopes.flatMap((sc) => sc.artifacts).find((a) => a.id === "bogus.cap");
  assert.equal(art.status, "unrestorable");
  assert.equal(art.code, "invalid-source");
  assert.notEqual(r.status, 0);
  rmSync(base, { recursive: true, force: true });
});

test("valueless --dir is E_BAD_ARGS inside the JSON boundary for every lifecycle command (reviewer-6f0a3bd)", () => {
  const base = temp();
  const s = scope(base);
  for (const argv of [["list"], ["install"], ["trust", "x.cap"], ["update", "x.p"], ["remove", "x.p"], ["migrate"]]) {
    const r = cli(s, ...argv, "--dir", "--json");
    const env = JSON.parse(r.stdout); // throws on a stack trace / empty stdout
    assert.equal(env.ok, false, argv.join(" "));
    assert.equal(env.error.code, "E_BAD_ARGS", argv.join(" "));
    assert.notEqual(r.status, 0);
    assert.ok(!r.stderr.includes("TypeError"), "no uncaught stack trace");
  }
  rmSync(base, { recursive: true, force: true });
});

test("typed codes preserved: retired manifest → retired-capability; malformed lock at install → invalid-lock (reviewer-6f0a3bd)", () => {
  const base = temp();
  const s = scope(base);
  // local capability whose oas.json declares the retired oas.web
  const retired = join(base, "retired-cap");
  write(join(retired, "oas.json"), JSON.stringify({ capability: "oas.web", version: "1.0.0", description: "d" }));
  let env = JSON.parse(cli(s, "install", retired, "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "retired-capability", "typed retirement code, not catch-all invalid-source");
  // malformed lock JSON at a package install → invalid-lock, not legacy-lock
  const s2 = scope(base, "s2");
  writeFileSync(join(s2, OAS_LOCK_FILE), "{ nope");
  const pkg = pkgSource(join(base, "pkg"), { package: "ml.p" });
  env = JSON.parse(cli(s2, "install", pkg, "--dir", s2, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock", "malformed JSON is invalid-lock, not legacy-lock");
  rmSync(base, { recursive: true, force: true });
});

// ---------- corrective item 5: same-bytes drift vs existing lock (coordinator mail 169d7944) ----------

test("re-acquisition cannot re-legitimize same-bytes drift against an existing lock (item 5)", () => {
  const base = temp();
  const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "dr.p" }, { "cap": { capability: "dr.cap", commands: { r: { exec: "r.mjs" } } } });
  write(join(src, "cap", "r.mjs"), "// v1\n");
  acquirePackage(s, src);
  approveCapability(s, "dr.cap");
  const lockBefore = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
  // drift SOURCE and INSTALLED trees to the SAME bytes post-acquisition
  const dest = join(installedPackagesDir(s), "dr.p");
  write(join(src, "cap", "r.mjs"), "// drifted identically\n");
  write(join(dest, "cap", "r.mjs"), "// drifted identically\n");
  // re-acquire: keep-path integrities match each other but NOT the lock → integrity-drift
  assert.throws(() => acquirePackage(s, src), (e) => e.code === "integrity-drift" && /oas update/.test(e.message));
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), lockBefore, "lock unchanged — drift not re-legitimized");
  // no trust survival through the drift: the query fails closed on the drifted artifact
  const t = capabilityTrust(s, "dr.cap");
  assert.equal(t.trusted, false, "approval does not survive the drift");
  // explicit update is the sanctioned advancement path
  const r = updatePackage(s, "dr.p", { spec: src });
  assert.equal(r.changed, true);
  assert.deepEqual(readPackageLocks(s).packages["dr.p"].trustedCapabilities, [], "approvals reset by the explicit update");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-176d339 findings ----------

test("no coercion anywhere: non-string array items, array depsIntegrity, numeric package id all rejected (reviewer-176d339)", () => {
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  const mk = (over) => ({ source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: ["x.c"], ...over });
  // array depsIntegrity coerced through String() previously
  assert.throws(() => validateLockEntry("p", mk({ depsIntegrity: [integ] }), {}, {}), (e) => e.code === "invalid-lock" && /depsIntegrity/.test(e.message));
  // schema-invalid array MEMBERS
  assert.throws(() => validateLockEntry("p", mk({ capabilities: [123] }), {}, {}), (e) => e.code === "invalid-lock" && /non-string/.test(e.message));
  assert.throws(() => validateLockEntry("p", mk({ trustedCapabilities: [123], capabilities: ["x.c"] }), {}, {}), (e) => e.code === "invalid-lock");
  assert.throws(() => validateLockEntry("p", mk({ dependencies: ["Not A Valid Id!"] }), { p: mk({}) }, {}), (e) => e.code === "invalid-lock" && /invalid package id/.test(e.message));
  // numeric package id in the manifest
  const base = temp();
  const d = join(base, "n");
  write(join(d, "oas-package.json"), JSON.stringify({ package: 123, version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" } }));
  assert.throws(() => loadPackageManifestAt(d), (e) => e.code === "invalid-package-manifest" && /string "package"/.test(e.message));
  rmSync(base, { recursive: true, force: true });
});

test("malformed residue CONTAINERS are typed invalid-lock in read and both doctor outputs (reviewer-176d339)", () => {
  const base = temp();
  for (const [label, container] of [["number", 1], ["null", null], ["array", []]]) {
    const s = scope(base, `s-${label}`);
    writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: container }));
    // read raises typed
    assert.throws(() => readPackageLocks(s), (e) => e.code === "invalid-lock" && /must be an object map/.test(e.message), label);
    // doctor human diagnoses (does not crash, does not stay silent)
    const rh = cli(s, "doctor", s);
    assert.equal(rh.status, 0, rh.stderr);
    assert.match(rh.stdout, /invalid-lock/, label);
    // doctor JSON carries the lockError with provenance instead of empty residue + null
    const dj = JSON.parse(cli(s, "doctor", s, "--json").stdout);
    const lockErr = dj.lockError || dj.error;
    assert.ok(lockErr && lockErr.code === "invalid-lock", `${label}: ${JSON.stringify(lockErr)}`);
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-b671de0 finding: retired flags reject BEFORE any mutation ----------

test("retired spawn flags reject before local-agent upsert — no soul scaffolded or overwritten (reviewer-b671de0)", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: t\n");
  const root = join(ws, "agents");
  mkdirSync(root, { recursive: true });
  const repo = join(ws, "wsrepo");
  write(join(repo, "README.md"), "r\n");
  gitify(repo);
  const instr = join(base, "scratch.md");
  write(instr, "# Scratch\n\nDo things.\n");
  const localSoul = join(ws, "local-agents", "scratch");
  for (const retired of ["--instance", "--ephemeral"]) {
    const r = cli(ws, "spawn", "scratch", "--instructions-file", instr, retired, "legacy", "--no-launch", "--dir", ws, "--json");
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false, retired);
    assert.equal(env.error.code, "E_BAD_ARGS");
    assert.ok(!existsSync(localSoul), `${retired}: no local soul scaffolded before the rejection`);
  }
  // overwrite protection: pre-existing local soul must be untouched by a rejected spawn
  const r0 = cli(ws, "spawn", "scratch", "--instructions-file", instr, "--repo", repo, "--no-launch", "--dir", ws, "--json");
  assert.equal(JSON.parse(r0.stdout).ok, true, r0.stdout);
  const soulFile = join(localSoul, "soul", "AGENTS.md");
  const before = readFileSync(soulFile, "utf8");
  const instr2 = join(base, "scratch2.md");
  write(instr2, "# Overwritten\n\nDifferent body.\n");
  const r1 = cli(ws, "spawn", "scratch", "--instructions-file", instr2, "--repo", repo, "--instance", "x", "--no-launch", "--dir", ws, "--json");
  assert.equal(JSON.parse(r1.stdout).ok, false);
  assert.equal(readFileSync(soulFile, "utf8"), before, "existing local soul not overwritten by the rejected spawn");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-11752b2 findings: scan scope, reachability, preflight ----------

test("platform scan: omitted dev/peer entries (even scripted/native) ignored; v1 lockfile fails closed (reviewer-11752b2 + maintainer 19fbc86 ruling)", () => {
  const base = temp();
  const s = scope(base);
  const integ = "sha512-AAA";
  // Detector-scope assertion runs on the exported scanner over a SYNTHETIC
  // lock only — the fake omitted entries (unreachable https://x/*.tgz, bogus
  // integrity) must never reach npm ci: a clean-cache npm validates/resolves
  // them during materialization and fails before any assertion (CI-portability
  // fix; product behavior unchanged).
  const syntheticLock = join(base, "synthetic-package-lock.json");
  write(syntheticLock, JSON.stringify({
    name: "sc-ok", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "sc-ok", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } },
      "node_modules/dep": { resolved: "vendor/dep", link: true },
      "vendor/dep": { version: "1.0.0" },
      "node_modules/dev-native": { version: "1.0.0", resolved: "https://x/d.tgz", integrity: integ, dev: true, os: ["darwin"] },
      "node_modules/peer-native": { version: "1.0.0", resolved: "https://x/p.tgz", integrity: integ, peer: true, cpu: ["arm64"] },
      "node_modules/dev-scripted": { version: "1.0.0", resolved: "vendor/dep", link: true, dev: true, hasInstallScript: true },
    },
  }));
  assert.deepEqual(platformVariantLockPackages(syntheticLock), [], "omitted dev/peer natives and dev install scripts are outside the scan scope");
  // acquire-success assertion uses a VALID, purely local production closure
  // (file: link only) that npm ci accepts offline with a clean cache
  const okSrc = pkgSource(join(base, "ok"), { package: "sc.ok" }, { "cap": { capability: "sc.okcap" } });
  write(join(okSrc, "vendor/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(okSrc, "package.json"), JSON.stringify({ name: "sc-ok", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(okSrc, "package-lock.json"), JSON.stringify({
    name: "sc-ok", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "sc-ok", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } },
      "node_modules/dep": { resolved: "vendor/dep", link: true },
      "vendor/dep": { version: "1.0.0" },
    },
  }));
  const r = acquirePackage(s, okSrc);
  assert.equal(r.root, "sc.ok", "valid local production closure acquires cleanly");
  // production os/cpu constraint still rejects
  const bad = pkgSource(join(base, "bad"), { package: "sc.bad" });
  write(join(bad, "package.json"), JSON.stringify({ name: "sc-bad", version: "1.0.0", dependencies: { n: "1.0.0" } }));
  write(join(bad, "package-lock.json"), JSON.stringify({ name: "sc-bad", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "sc-bad", version: "1.0.0", dependencies: { n: "1.0.0" } }, "node_modules/n": { version: "1.0.0", resolved: "https://x/n.tgz", integrity: integ, os: ["linux"] } } }));
  assert.throws(() => acquirePackage(scope(base, "s2"), bad), /os\/cpu\/libc/);
  // lockfile v1 (nested dependencies, no packages map) fails closed
  const v1 = pkgSource(join(base, "v1"), { package: "sc.v1" });
  write(join(v1, "package.json"), JSON.stringify({ name: "sc-v1", version: "1.0.0", dependencies: { n: "1.0.0" } }));
  write(join(v1, "package-lock.json"), JSON.stringify({ name: "sc-v1", version: "1.0.0", lockfileVersion: 1, requires: true, dependencies: { n: { version: "1.0.0", resolved: "https://x/n.tgz", integrity: integ, os: ["linux"] } } }));
  assert.throws(() => acquirePackage(scope(base, "s3"), v1), /unsupported npm lockfileVersion/);
  rmSync(base, { recursive: true, force: true });
});

test("platform scan is a transaction-wide preflight incl. kept/no-op paths (reviewer-11752b2)", () => {
  const base = temp();
  const s = scope(base);
  const integ = "sha512-AAA";
  // package with CLEAN root lock + PROHIBITED per-capability lock: nothing materializes
  const src = pkgSource(join(base, "src"), { package: "pf.p" }, { "capdir": { capability: "pf.cap" } });
  write(join(src, "vendor/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(src, "package.json"), JSON.stringify({ name: "pf-root", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(src, "package-lock.json"), JSON.stringify({ name: "pf-root", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "pf-root", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }, "node_modules/dep": { resolved: "vendor/dep", link: true }, "vendor/dep": { version: "1.0.0" } } }));
  write(join(src, "capdir", "package.json"), JSON.stringify({ name: "pf-cap", version: "1.0.0", dependencies: { n: "1.0.0" } }));
  write(join(src, "capdir", "package-lock.json"), JSON.stringify({ name: "pf-cap", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "pf-cap", version: "1.0.0", dependencies: { n: "1.0.0" } }, "node_modules/n": { version: "1.0.0", resolved: "https://x/n.tgz", integrity: integ, os: ["linux"] } } }));
  assert.throws(() => acquirePackage(s, src), /platform-variant/);
  assert.ok(!existsSync(join(installedPackagesDir(s), "pf.p")), "nothing installed");
  // kept/no-op path: a pre-existing installed package whose lock is prohibited fails the no-op acquire
  const s2 = scope(base, "s2");
  const clean = pkgSource(join(base, "clean"), { package: "np.p" });
  acquirePackage(s2, clean);
  const dest = join(installedPackagesDir(s2), "np.p");
  // inject a prohibited closure into BOTH source and installed trees (same bytes → keep-path)
  for (const d of [clean, dest]) {
    write(join(d, "package.json"), JSON.stringify({ name: "np-p", version: "1.0.0", dependencies: { n: "1.0.0" } }));
    write(join(d, "package-lock.json"), JSON.stringify({ name: "np-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "np-p", version: "1.0.0", dependencies: { n: "1.0.0" } }, "node_modules/n": { version: "1.0.0", resolved: "https://x/n.tgz", integrity: integ, os: ["linux"] } } }));
  }
  // (the recorded-lock-integrity guard fires first for the drift — use replace to reach the keep/scan path)
  assert.throws(() => acquirePackage(s2, clean, { replace: true }), /platform-variant/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-5f1188d blockers: strict root/map shapes, additionalProperties ----------

test("lock root and packages-map shapes are strictly validated everywhere (reviewer-5f1188d)", () => {
  const base = temp();
  const shapes = [
    ["array-root", "[]"],
    ["null-root", "null"],
    ["scalar-root", "42"],
    ["v2-null-packages", JSON.stringify({ lockfileVersion: 2, packages: null })],
    ["v2-array-packages", JSON.stringify({ lockfileVersion: 2, packages: [] })],
    ["v2-string-packages", JSON.stringify({ lockfileVersion: 2, packages: "" })],
    ["v2-missing-packages", JSON.stringify({ lockfileVersion: 2 })],
    ["string-version", JSON.stringify({ lockfileVersion: "2", packages: {} })],
    ["unsupported-version", JSON.stringify({ lockfileVersion: 3, packages: {} })],
  ];
  for (const [label, body] of shapes) {
    const s = scope(base, `s-${label}`);
    writeFileSync(join(s, OAS_LOCK_FILE), body);
    // read raises typed
    assert.throws(() => readPackageLocks(s), (e) => e.code === "invalid-lock", `read ${label}`);
    // restore raises typed
    assert.throws(() => restorePackages(s), (e) => e.code === "invalid-lock", `restore ${label}`);
    // list (with a store dir present — the doctor-crash repro) raises typed via the envelope
    mkdirSync(installedPackagesDir(s), { recursive: true });
    const r = cli(s, "list", "--dir", s, "--json");
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false, `list ${label}`);
    assert.equal(env.error.code, "invalid-lock", `list ${label}`);
    // doctor human catches the typed error and diagnoses (no crash)
    const rh = cli(s, "doctor", s);
    assert.equal(rh.status, 0, `doctor ${label}: ${rh.stderr.slice(0, 200)}`);
    assert.match(rh.stdout, /invalid-lock/, `doctor ${label}`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("lock entries enforce additionalProperties: false (reviewer-5f1188d)", () => {
  const base = temp();
  const s = scope(base);
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 2,
    packages: { "x.p": { source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: [], wat: true } },
  }));
  assert.throws(() => readPackageLocks(s), (e) => e.code === "invalid-lock" && /unknown keys: wat/.test(e.message));
  assert.throws(() => restorePackages(s), (e) => e.code === "invalid-lock");
  const env = JSON.parse(cli(s, "list", "--dir", s, "--json").stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-2a4adec blocker: path:sub / whitespace relative-dep bypass ----------

test("relative-dep rejection classifies from the parsed payload — path:sub and whitespace variants cannot resolve via CWD (reviewer-2a4adec)", () => {
  const base = temp();
  const s = scope(base);
  // CWD contains a VALID matching package dir — the bait the bypass would install
  const elsewhere = join(base, "cwd");
  pkgSource(join(elsewhere, "sub"), { package: "bait.p" }, { "cap": { capability: "bait.cap" } });
  const prevCwd = process.cwd();
  try {
    process.chdir(elsewhere);
    for (const spelling of ["path:sub", " ./sub "]) {
      const g = pkgSource(join(base, `g-${spelling.replace(/[^a-z]/g, "")}`), { package: "gp.rel", dependencies: [spelling] });
      gitify(g);
      const lockBefore = existsSync(join(s, OAS_LOCK_FILE)) ? readFileSync(join(s, OAS_LOCK_FILE), "utf8") : null;
      assert.throws(() => acquirePackage(s, `file://${g}#.`), (e) => e.code === "invalid-source" && /relative path/.test(e.message), spelling);
      assert.ok(!existsSync(join(installedPackagesDir(s), "bait.p")), `${spelling}: CWD bait not installed`);
      assert.ok(!existsSync(join(installedPackagesDir(s), "gp.rel")), `${spelling}: remote package not installed either (transaction failed whole)`);
      const lockAfter = existsSync(join(s, OAS_LOCK_FILE)) ? readFileSync(join(s, OAS_LOCK_FILE), "utf8") : null;
      assert.equal(lockAfter, lockBefore, `${spelling}: lock unchanged`);
    }
    // legitimate co-located local packages still work with path:sub spelling
    const localRoot = join(base, "local");
    pkgSource(join(localRoot, "sub"), { package: "loc.sub" });
    pkgSource(localRoot, { package: "loc.root", dependencies: ["path:sub"] });
    const r = acquirePackage(s, localRoot);
    assert.deepEqual(r.installed.map((p) => p.package).sort(), ["loc.root", "loc.sub"]);
    assert.match(readPackageLocks(s).packages["loc.sub"].source, /path:.*\/local\/sub$/, "resolved against the depending package root, not CWD");
  } finally {
    process.chdir(prevCwd);
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-21849d4 findings ----------

test("unknown lockfileVersion is never rewritten by migrate — fail closed (reviewer-21849d4)", () => {
  const base = temp();
  const s = scope(base);
  const body = JSON.stringify({ lockfileVersion: 3, packages: { "future.p": { some: "data" } }, capabilities: {} }, null, 2);
  writeFileSync(join(s, OAS_LOCK_FILE), body);
  // dry-run fails closed
  let r = cli(s, "migrate", "--dry-run", "--dir", s, "--json");
  let env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock");
  // real migrate fails closed and DESTROYS NOTHING
  r = cli(s, "migrate", "--dir", s, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock");
  assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), body, "unknown-version lock byte-identical — never rewritten");
  rmSync(base, { recursive: true, force: true });
});

test("empty-v1 conversion is atomic: a failed replace leaves the original lock byte-identical (reviewer-21849d4)", () => {
  const base = temp();
  const s = scope(base);
  const original = JSON.stringify({ lockfileVersion: 1, capabilities: {} }, null, 2);
  writeFileSync(join(s, OAS_LOCK_FILE), original);
  // fault injection: make the scope dir read-only so the temp-file write fails
  // (the destination file itself stays writable-in-place — a truncating write
  // WOULD have succeeded and left a partial file; the atomic path cannot).
  execFileSync("chmod", ["555", s]);
  try {
    assert.throws(() => applyLegacyLockMigration(s), /EACCES|EPERM|permission/i);
    assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), original, "original bytes preserved through the failed conversion");
  } finally {
    execFileSync("chmod", ["755", s]);
  }
  // and the successful path still converts
  const r = applyLegacyLockMigration(s);
  assert.equal(r.formatConverted, true);
  assert.deepEqual(JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8")), { lockfileVersion: 2, packages: {} });
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-038b6cb findings ----------

test("malformed lock roots are typed invalid-lock on install paths — package and legacy (reviewer-038b6cb)", () => {
  const base = temp();
  const pkg = pkgSource(join(base, "pkg"), { package: "mr.p" });
  const legacy = join(base, "legacy-cap");
  write(join(legacy, "oas.json"), JSON.stringify({ capability: "mr.cap", version: "1.0.0", description: "d" }));
  for (const [label, body] of [["null-root", "null"], ["array-root", "[]"], ["scalar-root", "42"]]) {
    const s = scope(base, `s-${label}`);
    writeFileSync(join(s, OAS_LOCK_FILE), body);
    // package install path
    let env = JSON.parse(cli(s, "install", pkg, "--dir", s, "--json").stdout);
    assert.equal(env.ok, false, `pkg ${label}`);
    assert.equal(env.error.code, "invalid-lock", `pkg ${label}: ${env.error.message}`);
    assert.ok(!/Cannot read properties/.test(env.error.message), `pkg ${label}: no TypeError leak`);
    // legacy capability install path (writeCapabilityLock guard)
    env = JSON.parse(cli(s, "install", legacy, "--dir", s, "--json").stdout);
    assert.equal(env.ok, false, `legacy ${label}`);
    assert.equal(env.error.code, "invalid-lock", `legacy ${label}: ${env.error.message}`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("restoreCapabilities preserves e.code — retired manifest in a locked path source reports retired-capability (reviewer-038b6cb)", () => {
  const base = temp();
  const s = scope(base);
  // a locked path source whose manifest declares retired oas.web
  const retiredSrc = join(base, "retired-src");
  write(join(retiredSrc, "oas.json"), JSON.stringify({ capability: "oas.web", version: "1.0.0", description: "d" }));
  writeCapabilityLock(s, "some.cap", { source: `path:${retiredSrc}`, version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  const r = cli(s, "install", "--dir", s, "--json");
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  // ADAPTED for the merged CLI (WS2 reconcile envelope): the typed retirement
  // code is preserved on the PER-ARTIFACT row, under the E_RECONCILE_FAILED
  // aggregate — the code is never flattened away (the assertion's point).
  assert.equal(env.error.code, "E_RECONCILE_FAILED");
  const art = env.error.details.scopes.flatMap((sc) => sc.artifacts).find((a) => a.id === "some.cap");
  assert.equal(art.code, "retired-capability", `expected typed retirement code, got ${art?.code}: ${art?.reason}`);
  rmSync(base, { recursive: true, force: true });
});

// ---------- maintainer 19fbc86 ruling: included optional/install-script/native-binary rejection ----------

test("included optional deps and post-materialization .node binaries are rejected (maintainer 19fbc86)", () => {
  const base = temp();
  const s = scope(base);
  const integ = "sha512-AAA";
  // included optionalDependency variance rejected at preflight
  const opt = pkgSource(join(base, "opt"), { package: "op.p" });
  write(join(opt, "package.json"), JSON.stringify({ name: "op-p", version: "1.0.0", optionalDependencies: { maybe: "1.0.0" } }));
  write(join(opt, "package-lock.json"), JSON.stringify({ name: "op-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "op-p", version: "1.0.0", optionalDependencies: { maybe: "1.0.0" } }, "node_modules/maybe": { version: "1.0.0", resolved: "https://x/m.tgz", integrity: integ, optional: true } } }));
  assert.throws(() => acquirePackage(s, opt), /optional dependency/);
  // a .node binary landing in the MATERIALIZED tree is rejected post-npm-ci
  const nb = pkgSource(join(base, "nb"), { package: "nb.p" });
  write(join(nb, "vendor/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(nb, "vendor/dep/prebuilt.node"), "\x00fake-native\x00");
  write(join(nb, "package.json"), JSON.stringify({ name: "nb-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(nb, "package-lock.json"), JSON.stringify({ name: "nb-p", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "nb-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }, "node_modules/dep": { resolved: "vendor/dep", link: true }, "vendor/dep": { version: "1.0.0" } } }));
  assert.throws(() => acquirePackage(scope(base, "s2"), nb), (e) => /native binary/.test(e.message) && /prebuilt\.node/.test(e.message));
  assert.ok(!existsSync(join(installedPackagesDir(scope(base, "s2")), "nb.p")), "rollback: nothing installed");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-7b2cd36 findings ----------

test("valueless --dir is E_BAD_ARGS for status/spawn/retire/create too (reviewer-7b2cd36)", () => {
  const base = temp();
  const s = scope(base);
  for (const argv of [["status"], ["spawn", "x"], ["retire", "x"], ["create", "x"]]) {
    const r = cli(s, ...argv, "--dir", "--json");
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false, argv.join(" "));
    assert.equal(env.error.code, "E_BAD_ARGS", `${argv.join(" ")}: ${env.error.message}`);
    assert.ok(!r.stderr.includes("TypeError"), `${argv.join(" ")}: no stack trace`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("human-mode bare restore exits nonzero for retired locks (reviewer-7b2cd36)", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "oas.web", { source: "marketplace:oas.web@1.0.0", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` });
  const r = cli(s, "install", "--dir", s);
  assert.notEqual(r.status, 0, "retired lock must fail the restore exit code");
  assert.match(r.stdout, /RETIRED\s+oas\.web/, "actionable RETIRED rendering retained");
  // ADAPTED for the merged CLI: the human failure summary is the reconcile
  // wording ("N failure(s) during restore/reconciliation"), same nonzero exit.
  assert.match(r.stderr, /failure.* during restore\/reconciliation/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- maintainer 2nd detector-round item: central parser on the writer (mail aba5e845) ----------

test("writePackageLock routes through the central parser — all malformed roots/maps typed invalid-lock pre-mutation (maintainer)", () => {
  const base = temp();
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  const entry = { source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: [] };
  const shapes = [["malformed", "{ nope"], ["null-root", "null"], ["scalar-root", "42"], ["array-root", "[]"],
    ["bad-packages", JSON.stringify({ lockfileVersion: 2, packages: "x" })],
    ["bad-residue", JSON.stringify({ lockfileVersion: 1, capabilities: [] })]];
  for (const [label, body] of shapes) {
    const s = scope(base, `s-${label}`);
    writeFileSync(join(s, OAS_LOCK_FILE), body);
    assert.throws(() => writePackageLock(s, "x.p", entry), (e) => e.code === "invalid-lock", `writePkg ${label}`);
    assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), body, `${label}: file untouched pre-mutation`);
    // migrate paths also typed (no raw SyntaxError/TypeError)
    const r = cli(s, "migrate", "--dry-run", "--dir", s, "--json");
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false, `migrate ${label}`);
    assert.equal(env.error.code, "invalid-lock", `migrate ${label}`);
  }
  // writer preserves residue through a legitimate write on a mixed-v2 lock
  const s2 = scope(base, "mixed");
  writeCapabilityLock(s2, "res.cap", { source: "marketplace:res.cap@1", version: "1", integrity: `sha256-${"b".repeat(64)}` });
  applyLegacyLockMigration(s2, { catalog: () => undefined });
  writePackageLock(s2, "np.p", entry);
  const parsed = JSON.parse(readFileSync(join(s2, OAS_LOCK_FILE), "utf8"));
  assert.ok(parsed.packages["np.p"], "package written");
  assert.ok(parsed.capabilities["res.cap"], "residue preserved byte-semantically through the central-parser writer");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-c44b73c live findings (3-5; 1-2 fixed in 16acf8c/12af640) ----------

test("configs: null is invalid-package-manifest; non-string packageId rejected by the writer (reviewer-c44b73c)", () => {
  const base = temp();
  const d = join(base, "m");
  write(join(d, "oas-package.json"), JSON.stringify({ package: "x.p", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, configs: null }));
  assert.throws(() => loadPackageManifestAt(d), (e) => e.code === "invalid-package-manifest" && /configs/.test(e.message));
  const s = scope(base);
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  const entry = { source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: [] };
  for (const badId of [123, true, ["a"], null]) {
    assert.throws(() => writePackageLock(s, badId, entry), (e) => e.code === "invalid-lock" && /must be a string/.test(e.message), JSON.stringify(badId));
  }
  rmSync(base, { recursive: true, force: true });
});

test("schema-invalid residue entries are typed invalid-lock before migration planning — no coercion (reviewer-c44b73c)", () => {
  const base = temp();
  const s = scope(base);
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: { "x.cap": { source: ["marketplace:x"], version: "1", integrity: `sha256-${"a".repeat(64)}` } } }));
  assert.throws(() => migrateLegacyLock(s), (e) => e.code === "invalid-lock" && /malformed/.test(e.message), "array source never normalizes into a plan");
  const r = cli(s, "migrate", "--dry-run", "--dir", s, "--json");
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "invalid-lock");
  rmSync(base, { recursive: true, force: true });
});

test("non-reader paths validate residue containers and packages shapes (reviewer-c44b73c findings 1-2 pinned at head)", () => {
  const base = temp();
  const sha = "a".repeat(40);
  const integ = `sha256-${"0".repeat(64)}`;
  const entry = { source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: [] };
  // v2 with capabilities: null — restore and write both raise
  const s = scope(base, "s1");
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: null }));
  assert.throws(() => restorePackages(s), (e) => e.code === "invalid-lock");
  assert.throws(() => writePackageLock(s, "x.p", entry), (e) => e.code === "invalid-lock");
  // falsy/invalid packages containers — writer raises, never silently repairs
  for (const [label, body] of [["false", JSON.stringify({ lockfileVersion: 2, packages: false })], ["zero", JSON.stringify({ lockfileVersion: 2, packages: 0 })], ["empty-string", JSON.stringify({ lockfileVersion: 2, packages: "" })]]) {
    const s2 = scope(base, `s-${label}`);
    writeFileSync(join(s2, OAS_LOCK_FILE), body);
    assert.throws(() => writePackageLock(s2, "x.p", entry), (e) => e.code === "invalid-lock", label);
    assert.equal(readFileSync(join(s2, OAS_LOCK_FILE), "utf8"), body, `${label}: never silently repaired`);
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-b875620 blocker: devOptional is production-reachable ----------

test("devOptional entries stay IN scan scope — link entry + devOptional target with os constraint rejects (reviewer-b875620)", () => {
  const base = temp();
  const s = scope(base);
  const integ = "sha512-AAA";
  // npm-shaped lock (npm 10.9.4 repro shape): node_modules/<name> is a bare
  // link entry; the TARGET carries devOptional + os — installed by the omit set.
  const src = pkgSource(join(base, "src"), { package: "dv.p" }, { "cap": { capability: "dv.cap" } });
  write(join(src, "vendor/nat/package.json"), JSON.stringify({ name: "nat", version: "1.0.0" }));
  write(join(src, "package.json"), JSON.stringify({ name: "dv-p", version: "1.0.0", optionalDependencies: { nat: "file:vendor/nat" } }));
  write(join(src, "package-lock.json"), JSON.stringify({
    name: "dv-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "dv-p", version: "1.0.0", optionalDependencies: { nat: "file:vendor/nat" } },
      "node_modules/nat": { resolved: "vendor/nat", link: true },
      "vendor/nat": { version: "1.0.0", devOptional: true, os: ["darwin"] },
    },
  }));
  assert.throws(() => acquirePackage(s, src), /os\/cpu\/libc/, "devOptional target with an os constraint must not bypass the scan");
  // a devOptional PURE entry without platform markers still passes (no over-rejection)
  const ok = pkgSource(join(base, "ok"), { package: "dvo.p" }, { "cap": { capability: "dvo.cap" } });
  write(join(ok, "vendor/pj/package.json"), JSON.stringify({ name: "pj", version: "1.0.0" }));
  write(join(ok, "package.json"), JSON.stringify({ name: "dvo-p", version: "1.0.0", optionalDependencies: { pj: "file:vendor/pj" } }));
  write(join(ok, "package-lock.json"), JSON.stringify({
    name: "dvo-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "dvo-p", version: "1.0.0", optionalDependencies: { pj: "file:vendor/pj" } },
      "node_modules/pj": { resolved: "vendor/pj", link: true },
      "vendor/pj": { version: "1.0.0", devOptional: true },
    },
  }));
  // NOTE: per the maintainer's included-optional ruling, entries flagged
  // `optional: true` reject; devOptional WITHOUT platform markers or optional
  // flag on the target passes (dev-and-optional duality is metadata, the
  // materialized bytes are platform-invariant).
  const r = acquirePackage(scope(base, "s2"), ok);
  assert.equal(r.root, "dvo.p");
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-3626ef2 blocker: tilde expansion reaches $HOME from remote manifests ----------

test("tilde dependency spellings from git parents are rejected — no ambient $HOME resolution (reviewer-3626ef2)", () => {
  const base = temp();
  const s = scope(base);
  // valid bait package under $HOME (the reviewer's repro shape)
  const baitName = `.oas-test-bait-${process.pid}`;
  const bait = join(homedir(), baitName);
  pkgSource(bait, { package: "hbait.p" }, { "cap": { capability: "hbait.cap" } });
  try {
    for (const spelling of [`~/${baitName}`, `path:~/${baitName}`]) {
      const g = pkgSource(join(base, `g-${spelling.replace(/[^a-z0-9]/gi, "")}`), { package: "gt.rel", dependencies: [spelling] });
      gitify(g);
      const lockBefore = existsSync(join(s, OAS_LOCK_FILE)) ? readFileSync(join(s, OAS_LOCK_FILE), "utf8") : null;
      assert.throws(() => acquirePackage(s, `file://${g}#.`), (e) => e.code === "invalid-source" && /relative path/.test(e.message), spelling);
      assert.ok(!existsSync(join(installedPackagesDir(s), "hbait.p")), `${spelling}: $HOME bait not installed`);
      assert.ok(!existsSync(join(installedPackagesDir(s), "gt.rel")), `${spelling}: whole-transaction failure`);
      const lockAfter = existsSync(join(s, OAS_LOCK_FILE)) ? readFileSync(join(s, OAS_LOCK_FILE), "utf8") : null;
      assert.equal(lockAfter, lockBefore, `${spelling}: lock unchanged`);
    }
    // CLI-level tilde use (operator-provided root spec) still resolves home-anchored
    const r = acquirePackage(s, `~/${baitName}`);
    assert.equal(r.root, "hbait.p", "operator tilde spec still works at the CLI root level");
  } finally {
    rmSync(bait, { recursive: true, force: true });
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-12e2d86 findings ----------

test("legacy restore validates the COMPLETE residue map before any acquisition (reviewer-12e2d86)", () => {
  const base = temp();
  const s = scope(base);
  const goodSrc = join(base, "good-cap");
  write(join(goodSrc, "oas.json"), JSON.stringify({ capability: "good.cap", version: "1.0.0", description: "d" }));
  const goodIntegrity = capabilityIntegrity(goodSrc);
  // Ordered good first, malformed bad second — old code restored good before throwing on bad.
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 2,
    packages: {},
    capabilities: {
      "good.cap": { source: `path:${goodSrc}`, version: "1.0.0", integrity: goodIntegrity },
      "bad.cap": null,
    },
  }, null, 2));
  const capStore = join(s, ".agents", "capabilities", "installed");
  assert.throws(() => restoreCapabilities(s), (e) => e.code === "invalid-lock" && /bad\.cap/.test(e.message));
  assert.ok(!existsSync(capStore) || readdirSync(capStore).length === 0, "complete-map preflight: good.cap was NOT restored before bad.cap failed");
  rmSync(base, { recursive: true, force: true });
});

test("malformed residue cannot grant marketplace/hoisted-path exemption during discovery (reviewer-12e2d86)", () => {
  const base = temp();
  const s = scope(base);
  // Installed standalone capability that would receive _marketplace from residue source.
  const cdir = join(s, ".agents", "capabilities", "installed", "evil-cap");
  write(join(cdir, "oas.json"), JSON.stringify({ capability: "evil.cap", version: "1.0.0", description: "d", skills: ["skills"] }));
  // malformed: source looks marketplace, but required version/integrity absent
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: { "evil.cap": { source: "marketplace:evil.cap@1" } } }));
  assert.throws(() => capabilityManifests(s), (e) => e.code === "invalid-lock" && /evil\.cap/.test(e.message), "discovery rejects before annotating _marketplace");
  assert.throws(() => resolveOasConfig(s), (e) => e.code === "invalid-lock", "untargeted resolution also fails closed — invalid data never consumed");
  rmSync(base, { recursive: true, force: true });
});

test("doctor human+JSON diagnose malformed v1 entries, including config-less lock-only scopes (reviewer-12e2d86)", () => {
  const base = temp();
  for (const [label, withConfig] of [["config", true], ["lock-only", false]]) {
    const s = join(base, label);
    mkdirSync(s, { recursive: true });
    if (withConfig) write(join(s, "oas-config.yaml"), "name: t\n");
    writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: { "x.c": null } }));
    // Human doctor: actionable invalid-lock, no silent pending-format-only report.
    const rh = cli(s, "doctor", s);
    assert.match(rh.stdout, /invalid-lock/, `${label}: human diagnosis`);
    assert.match(rh.stdout, /x\.c|legacy entry/, `${label}: offending entry named`);
    // JSON: either early typed error (config scope) or lockError (lock-only scope), never lockError:null/pending-only.
    const rj = cli(s, "doctor", s, "--json");
    const doc = JSON.parse(rj.stdout);
    const err = doc.error?.code ? doc.error : doc.lockError;
    assert.ok(err && err.code === "invalid-lock", `${label}: ${JSON.stringify(doc)}`);
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- reviewer-fe42de8 findings ----------

test("capability and package restore preflight the COMPLETE visible lock chain before mutation (reviewer-fe42de8)", () => {
  const base = temp();

  // Legacy capability restore: valid outer lock, malformed lock-only inner scope.
  const outerCap = join(base, "outer-cap"); mkdirSync(outerCap, { recursive: true });
  const innerCap = join(outerCap, "inner"); mkdirSync(innerCap);
  const capSrc = join(base, "cap-src");
  write(join(capSrc, "oas.json"), JSON.stringify({ capability: "good.cap", version: "1.0.0", description: "d" }));
  writeFileSync(join(outerCap, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: {
    "good.cap": { source: `path:${capSrc}`, version: "1.0.0", integrity: capabilityIntegrity(capSrc) },
  } }));
  writeFileSync(join(innerCap, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: { "bad.cap": null } }));
  assert.throws(() => restoreCapabilities(innerCap), (e) => e.code === "invalid-lock" && /bad\.cap/.test(e.message));
  assert.ok(!existsSync(join(outerCap, ".agents", "capabilities", "installed")), "outer capability was not restored before inner validation");

  // Package restore: same visible-chain ordering, with a valid local package source.
  const outerPkg = join(base, "outer-pkg"); mkdirSync(outerPkg);
  const innerPkg = join(outerPkg, "inner"); mkdirSync(innerPkg);
  const psrc = pkgSource(join(base, "pkg-src"), { package: "good.pkg" });
  writeFileSync(join(outerPkg, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: {
    "good.pkg": { source: `path:${psrc}`, path: ".", version: "1.0.0", commit: "local", integrity: packageIntegrity(psrc), capabilities: [] },
  } }));
  writeFileSync(join(innerPkg, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 2, packages: null }));
  assert.throws(() => restorePackages(innerPkg), (e) => e.code === "invalid-lock" && /packages/.test(e.message));
  assert.ok(!existsSync(join(installedPackagesDir(outerPkg), "good.pkg")), "outer package was not restored before inner validation");

  rmSync(base, { recursive: true, force: true });
});

test("apply migration validates v2 before no-residue fast path (reviewer-fe42de8)", () => {
  const base = temp();
  const malformed = [
    { lockfileVersion: 2, packages: {}, capabilities: null },
    { lockfileVersion: 2, packages: {}, capabilities: [] },
    { lockfileVersion: 2, packages: {}, capabilities: false },
    { lockfileVersion: 2, packages: {}, capabilities: "" },
    { lockfileVersion: 2, capabilities: {} },
    { lockfileVersion: 2, packages: null, capabilities: {} },
  ];
  for (const [i, doc] of malformed.entries()) {
    const s = join(base, `s${i}`); mkdirSync(s);
    const file = join(s, OAS_LOCK_FILE); const bytes = JSON.stringify(doc);
    writeFileSync(file, bytes);
    assert.throws(() => applyLegacyLockMigration(s), (e) => e.code === "invalid-lock", JSON.stringify(doc));
    assert.equal(readFileSync(file, "utf8"), bytes, "invalid v2 fast path never mutates");
  }
  rmSync(base, { recursive: true, force: true });
});

test("malformed retired v1 entry keeps actionable retirement priority in dry-run and apply (reviewer-fe42de8)", () => {
  const base = temp(); const s = join(base, "scope"); mkdirSync(s);
  const file = join(s, OAS_LOCK_FILE);
  writeFileSync(file, JSON.stringify({ lockfileVersion: 1, capabilities: { "oas.web": null } }));
  const dry = migrateLegacyLock(s);
  assert.equal(dry.plan[0].action, "manual");
  assert.match(dry.warnings.join("\n"), /oas\.web: retired.*OAS Desktop app/s);
  const applied = applyLegacyLockMigration(s);
  assert.deepEqual(applied.residue, ["oas.web"]);
  assert.match(applied.warnings.join("\n"), /oas\.web: retired.*OAS Desktop app/s);
  const final = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(final.lockfileVersion, 2);
  assert.equal(final.capabilities["oas.web"], null, "retired residue retained for explicit deletion guidance");
  rmSync(base, { recursive: true, force: true });
});

test("prototype-named malformed legacy entries are never misclassified as retired (reviewer-a5ed434)", () => {
  const base = temp();
  for (const [i, id] of ["constructor", "toString", "__proto__"].entries()) {
    const s = join(base, `s${i}`); mkdirSync(s);
    const file = join(s, OAS_LOCK_FILE);
    const bytes = JSON.stringify({ lockfileVersion: 1, capabilities: { [id]: null } });
    writeFileSync(file, bytes);
    assert.throws(() => migrateLegacyLock(s), (e) => e.code === "invalid-lock" && e.message.includes(id), `${id}: dry-run invalid-lock`);
    assert.throws(() => applyLegacyLockMigration(s), (e) => e.code === "invalid-lock" && e.message.includes(id), `${id}: apply invalid-lock`);
    assert.equal(readFileSync(file, "utf8"), bytes, `${id}: apply leaves lock byte-identical`);
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- final merged-state blocker round (reviewer-438abcf) ----------

test("unchanged acquire repairs tampered node_modules without blessing observed depsIntegrity", () => {
  const base = temp(); const s = scope(base);
  const src = pkgSource(join(base, "src"), { package: "keep.p" });
  write(join(src, "vendor/dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  write(join(src, "vendor/dep/index.js"), "module.exports = 1;\n");
  write(join(src, "package.json"), JSON.stringify({ name: "keep-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }));
  write(join(src, "package-lock.json"), JSON.stringify({
    name: "keep-p", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "keep-p", version: "1.0.0", dependencies: { dep: "file:vendor/dep" } }, "node_modules/dep": { resolved: "vendor/dep", link: true }, "vendor/dep": { version: "1.0.0" } },
  }));
  acquirePackage(s, src);
  const before = readPackageLocks(s).packages["keep.p"];
  const dest = join(installedPackagesDir(s), "keep.p");
  write(join(dest, "node_modules", "evil", "index.js"), "module.exports = 'planted';\n");
  assert.notEqual(packageDepsIntegrity(dest), before.depsIntegrity, "tamper changes observed runtime digest");

  const repaired = acquirePackage(s, src);
  assert.equal(repaired.installed.find((p) => p.package === "keep.p").kept, false, "digest mismatch is staged+swapped, never kept");
  assert.ok(!existsSync(join(dest, "node_modules", "evil")), "planted runtime content removed by deterministic rematerialization");
  const after = readPackageLocks(s).packages["keep.p"];
  assert.equal(after.depsIntegrity, before.depsIntegrity, "plain acquire never advances locked depsIntegrity from installed bytes");
  assert.equal(packageDepsIntegrity(dest), before.depsIntegrity, "repaired artifact matches prior runtime lock");
  rmSync(base, { recursive: true, force: true });
});

test("remove checks target own-scope dependents despite inner same-id shadow and rolls artifact back on write failure", () => {
  const base = temp();
  const outer = scope(base, "outer"); const inner = join(outer, "inner"); mkdirSync(inner);
  const dep = pkgSource(join(base, "dep"), { package: "shadow.dep" });
  const depCommit = gitify(dep);
  const root = pkgSource(join(base, "outer-root"), { package: "shadow.root", dependencies: [`file://${dep}@${depCommit}#.`] });
  acquirePackage(outer, root);
  // Inner same-id root has no dependency and hides outer shadow.root in the
  // closest-wins merged map used by the vulnerable implementation.
  const innerRoot = pkgSource(join(base, "inner-root"), { package: "shadow.root" });
  acquirePackage(inner, innerRoot);
  const outerLock = readFileSync(join(outer, OAS_LOCK_FILE), "utf8");
  const outerDepDir = join(installedPackagesDir(outer), "shadow.dep");
  assert.throws(() => removePackage(inner, "shadow.dep"), (e) => e.code === "remove-blocked" && /shadow\.root/.test(e.message));
  assert.ok(existsSync(outerDepDir), "own-scope dependent check occurs before artifact mutation");
  assert.equal(readFileSync(join(outer, OAS_LOCK_FILE), "utf8"), outerLock, "blocked removal leaves own lock byte-identical");

  // Independent package with no blockers: force the lock write to fail after
  // the artifact is moved, and require rollback of the installed directory.
  const rollbackScope = scope(base, "rollback");
  const solo = pkgSource(join(base, "solo"), { package: "solo.p" });
  acquirePackage(rollbackScope, solo);
  const lockFile = join(rollbackScope, OAS_LOCK_FILE);
  const lockBytes = readFileSync(lockFile, "utf8");
  const soloDir = join(installedPackagesDir(rollbackScope), "solo.p");
  chmodSync(lockFile, 0o444);
  try {
    assert.throws(() => removePackage(rollbackScope, "solo.p"));
    assert.ok(existsSync(soloDir), "artifact restored after lock-write failure");
    assert.equal(readFileSync(lockFile, "utf8"), lockBytes, "lock bytes preserved after failed remove");
  } finally { chmodSync(lockFile, 0o644); }
  rmSync(base, { recursive: true, force: true });
});

test("update preserves explicit catalog selector and lock metadata distinguishes bare catalog spec", () => {
  const base = temp();
  const pinned = pkgSource(join(base, "pinned"), { package: "select.p", version: "1.0.0" }); gitify(pinned);
  const latest = pkgSource(join(base, "latest"), { package: "select.p", version: "2.0.0" }); gitify(latest);
  const seen = [];
  const catalog = (id, selector) => {
    assert.equal(id, "select.p"); seen.push(selector);
    return { url: selector === "v1" ? pinned : latest, path: "." };
  };

  const explicitScope = scope(base, "explicit");
  acquirePackage(explicitScope, "select.p@v1", { catalog });
  assert.equal(readPackageLocks(explicitScope).packages["select.p"].source, "catalog:select.p@v1", "explicit original selector locked verbatim");
  seen.length = 0;
  const explicitUpdate = updatePackage(explicitScope, "select.p", { catalog });
  assert.deepEqual(seen, ["v1"], "update re-resolves the original explicit selector, not catalog default");
  assert.equal(explicitUpdate.after.version, "1.0.0");

  const bareScope = scope(base, "bare");
  acquirePackage(bareScope, "select.p", { catalog });
  assert.equal(readPackageLocks(bareScope).packages["select.p"].source, "catalog:select.p", "bare original spec remains distinguishable from explicit selector");
  seen.length = 0;
  updatePackage(bareScope, "select.p", { catalog });
  assert.deepEqual(seen, [undefined], "bare update deliberately re-resolves catalog default");
  rmSync(base, { recursive: true, force: true });
});

// ---------- final merged-state blocker round 2 (reviewer-06f1160) ----------

test("contained directory symlinks cannot hide second-hop skill or capability-agent escapes", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    tree.cap:\n      from: installed\n      global: true\n");
  const src = pkgSource(join(base, "src"), { package: "tree.p" }, {
    cap: { capability: "tree.cap", skills: ["skills"], agents: ["agents/reviewer"] },
  });
  const outside = join(base, "outside-secret.md"); write(outside, "HOST SECRET\n");

  // Skill two-hop: skills/in -> contained package vendor/skill, whose
  // SKILL.md -> host file. Immediate-target-only validation misses hop two.
  mkdirSync(join(src, "cap", "skills"), { recursive: true });
  mkdirSync(join(src, "vendor", "skill"), { recursive: true });
  symlinkSync("../../vendor/skill", join(src, "cap", "skills", "in"));
  symlinkSync(outside, join(src, "vendor", "skill", "SKILL.md"));

  // Agent two-hop: declared agents/reviewer -> contained vendor/reviewer,
  // whose AGENTS.md -> host file.
  mkdirSync(join(src, "cap", "agents"), { recursive: true });
  mkdirSync(join(src, "vendor", "reviewer"), { recursive: true });
  write(join(src, "vendor", "reviewer", "soul.yaml"), "name: reviewer\nkind: local\nruntime: pi\n");
  symlinkSync("../../vendor/reviewer", join(src, "cap", "agents", "reviewer"));
  symlinkSync(outside, join(src, "vendor", "reviewer", "AGENTS.md"));

  // Git clone preserves the authored relative directory links verbatim; local
  // cp may canonicalize them to source-tree absolute targets.
  gitify(src);
  acquirePackage(s, `file://${src}#.`);
  assert.throws(() => capabilitySkillDirs("tree.cap", s), /skill path escapes its integrity boundary/, "nested skill symlink escape rejected");
  assert.throws(() => findCapabilityAgent(s, join(base, "agents-root"), "reviewer"), /agent path escapes its integrity boundary/, "nested capability-agent symlink escape rejected");
  rmSync(base, { recursive: true, force: true });
});

test("read-only package gitignore is best-effort and cannot throw after acquisition commit", () => {
  const base = temp(); const s = scope(base);
  execFileSync("git", ["init", "-q", s]);
  const ignore = join(s, ".agents", "packages", ".gitignore");
  write(ignore, "# operator-owned\n"); chmodSync(ignore, 0o444);
  const src = pkgSource(join(base, "src"), { package: "ignore.p" });
  try {
    const result = acquirePackage(s, src);
    assert.equal(result.root, "ignore.p", "acquire returns success despite ignore maintenance failure");
    assert.ok(existsSync(join(installedPackagesDir(s), "ignore.p")), "artifact committed");
    assert.ok(readPackageLocks(s).packages["ignore.p"], "lock committed");
    assert.equal(readFileSync(ignore, "utf8"), "# operator-owned\n", "read-only ignore left untouched");
  } finally { chmodSync(ignore, 0o644); }
  rmSync(base, { recursive: true, force: true });
});

// ---------- final merged-state blocker round 3 (reviewer-d45641e) ----------

test("declared-not-active capability agents require locked provider integrity before returning prompt files", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    agent.sec:\n      from: installed\n      souls:\n        other: true\n");
  const src = pkgSource(join(base, "src"), { package: "agent.pkg" }, {
    cap: { capability: "agent.sec", agents: ["agents/reviewer"] },
  });
  write(join(src, "cap", "agents", "reviewer", "soul.yaml"), "name: reviewer\nkind: local\nruntime: pi\n");
  write(join(src, "cap", "agents", "reviewer", "AGENTS.md"), "SAFE\n");
  acquirePackage(s, src);
  const root = join(base, "agent-root");
  assert.equal(findCapabilityAgent(s, root, "reviewer").name, "reviewer", "instruction-only agent needs integrity, not executable approval");
  write(join(installedPackagesDir(s), "agent.pkg", "cap", "agents", "reviewer", "AGENTS.md"), "TAMPERED HOST PROMPT\n");
  assert.throws(() => findCapabilityAgent(s, root, "reviewer"), (e) => e.code === "integrity-drift" && /provider.*not trusted.*integrity differs/s.test(e.message));
  rmSync(base, { recursive: true, force: true });
});

test("CLI Git install falls back transactionally to documented standalone capability roots", () => {
  const base = temp(); const s = scope(base);
  const repo = join(base, "standalone");
  write(join(repo, "oas.json"), JSON.stringify({ capability: "legacy.git", version: "1.0.0", description: "legacy standalone" }));
  gitify(repo);
  const r = cli(s, "install", `file://${repo}`, "--dir", s, "--json");
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const envelope = JSON.parse(r.stdout);
  assert.equal(envelope.ok, true);
  const lock = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.equal(lock.lockfileVersion, 1);
  assert.equal(lock.capabilities["legacy.git"].source, `git:file://${repo}`);
  assert.ok(capabilityManifest("legacy.git", s), "standalone capability acquired through legacy path");
  assert.ok(!existsSync(join(installedPackagesDir(s), "legacy.git")), "no distribution-package artifact was committed during package probe");
  rmSync(base, { recursive: true, force: true });
});

test("Git root probe precedes v1 lock preflight and never falls back for dependency manifest errors", () => {
  const base = temp(); const s = scope(base);
  const standalone = (name, id) => {
    const repo = join(base, name);
    write(join(repo, "oas.json"), JSON.stringify({ capability: id, version: "1.0.0", description: "legacy" }));
    gitify(repo); return repo;
  };
  const one = standalone("one", "legacy.one");
  const two = standalone("two", "legacy.two");
  for (const repo of [one, two]) {
    const r = cli(s, "install", `file://${repo}`, "--dir", s, "--json");
    assert.equal(r.status, 0, r.stderr || r.stdout);
  }
  const v1 = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.ok(v1.capabilities["legacy.one"] && v1.capabilities["legacy.two"], "second standalone install bypasses package v1 preflight via root probe");

  // Dual-layout root is a PACKAGE. A non-package dependency must fail package
  // validation, never reinterpret the root's oas.json as legacy fallback.
  const dep = standalone("not-a-package-dep", "dep.legacy");
  const depCommit = execFileSync("git", ["-C", dep, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dual = pkgSource(join(base, "dual"), { package: "dual.pkg", dependencies: [`file://${dep}@${depCommit}#.`] });
  write(join(dual, "oas.json"), JSON.stringify({ capability: "dual.legacy", version: "1.0.0", description: "must not fallback" }));
  gitify(dual);
  const dualScope = scope(base, "dual-scope");
  const bad = cli(dualScope, "install", `file://${dual}#.`, "--dir", dualScope, "--json");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /invalid-package-manifest/);
  const dualLock = join(dualScope, OAS_LOCK_FILE);
  const after = existsSync(dualLock) ? JSON.parse(readFileSync(dualLock, "utf8")) : {};
  assert.equal(after.capabilities?.["dual.legacy"], undefined, "dependency error never falls back to dual-layout legacy root");
  rmSync(base, { recursive: true, force: true });
});

test("Git root selection hands one immutable inspected snapshot across standalone↔package source mutation", () => {
  const base = temp();
  // standalone at inspection, mutated remote becomes dual/package afterwards
  const standalone = join(base, "standalone");
  write(join(standalone, "oas.json"), JSON.stringify({ capability: "snap.cap", version: "1.0.0", description: "d" }));
  gitify(standalone);
  const capSnap = inspectGitSourceRoot(`file://${standalone}`);
  try {
    write(join(standalone, "oas-package.json"), JSON.stringify({ package: "evil.pkg", version: "1.0.0", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: [] }));
    gitCommit(standalone);
    const s = scope(base, "cap-scope");
    const r = acquireCapability(s, `file://${standalone}`, { rootSnapshot: capSnap });
    assert.equal(r.manifest.capability, "snap.cap");
    assert.equal(r.commit, capSnap.commit, "legacy acquisition uses inspected commit, not mutated remote head");
    assert.ok(!existsSync(join(r.dest, "oas-package.json")), "selected standalone snapshot cannot become dual-layout on second fetch");
  } finally { capSnap.cleanup(); }

  // package at inspection, mutated remote becomes standalone afterwards
  const pkg = pkgSource(join(base, "pkg"), { package: "snap.pkg" }); gitify(pkg);
  const pkgSnap = inspectGitSourceRoot(`file://${pkg}#.`);
  try {
    rmSync(join(pkg, "oas-package.json"));
    write(join(pkg, "oas.json"), JSON.stringify({ capability: "wrong.cap", version: "1.0.0", description: "d" }));
    gitCommit(pkg);
    const s = scope(base, "pkg-scope");
    const r = acquirePackage(s, `file://${pkg}#.`, { rootSnapshot: pkgSnap });
    assert.equal(r.root, "snap.pkg");
    assert.equal(r.installed[0].commit, pkgSnap.commit, "package acquisition uses inspected commit, not mutated remote head");
  } finally { pkgSnap.cleanup(); }
  rmSync(base, { recursive: true, force: true });
});

// ---------- configurable package payload root (contract §§1-9) ----------

/** A repository containing one or more packages at contained roots.
 * `layout` maps package path → { manifest, capabilities }. Returns the repo dir. */
function repoWithPackages(dir, layout, extras = {}) {
  for (const [rel, spec] of Object.entries(layout)) {
    pkgSource(rel === "." ? dir : join(dir, rel), spec.manifest, spec.capabilities || {});
  }
  for (const [rel, content] of Object.entries(extras)) write(join(dir, rel), content);
  gitify(dir);
  return dir;
}

test("package path parsing: git fragments normalize; catalog ids and local paths take none", () => {
  assert.equal(DEFAULT_PACKAGE_PATH, "oas-package");
  // Unselected: the parse records nothing and resolution applies the default.
  assert.equal(parsePackageSource("git:github.com/org/repo@v1").packagePath, undefined);
  // Every git spelling accepts the fragment, and the fragment is split BEFORE
  // the @ref so a path can never be swallowed by ref parsing.
  const sh = parsePackageSource("git:github.com/org/repo@v1.2.0#packages/core");
  assert.deepEqual({ ref: sh.ref, packagePath: sh.packagePath, normalized: sh.normalized },
    { ref: "v1.2.0", packagePath: "packages/core", normalized: "git:https://github.com/org/repo.git@v1.2.0" });
  assert.equal(parsePackageSource("https://host/org/repo.git@abc#sub").packagePath, "sub");
  assert.equal(parsePackageSource("git@host:org/repo.git@v2#a/b").packagePath, "a/b");
  // Every spelling of the repository root canonicalizes to exactly ".".
  for (const spelling of [".", "./", "./.", "", "  "]) {
    assert.equal(parsePackageSource(`https://h/x.git#${spelling}`).packagePath, ".", spelling);
  }
  assert.equal(parsePackageSource("https://h/x.git#./a//b/").packagePath, "a/b");
  // Local paths are exact directories; catalog paths come from the catalog.
  assert.equal(parsePackageSource("/abs/dir").packagePath, ".");
  for (const bad of ["/abs/dir#sub", "path:/abs/dir#sub", "./rel#sub", "oas.okf#sub", "oas.okf@v1#sub"]) {
    assert.throws(() => parsePackageSource(bad), (e) => e.code === "invalid-source" && /#<path>/.test(e.message), bad);
  }
  assert.throws(() => parsePackageSource("https://h/x.git#a#b"), (e) => e.code === "invalid-source" && /more than one/.test(e.message));
  assert.throws(() => parsePackageSource("#oas-package"), (e) => e.code === "invalid-source" && /names no source/.test(e.message));
});

test("normalizePackagePath: canonical relative forms only; traversal is path-escape", () => {
  assert.equal(normalizePackagePath(undefined), undefined, "absent lets the caller apply its own default");
  assert.equal(normalizePackagePath("."), ".");
  assert.equal(normalizePackagePath("a/./b/"), "a/b");
  for (const bad of ["/abs", "~/home", "~", "a\\b", "C:/x", "a\0b"]) {
    assert.throws(() => normalizePackagePath(bad), (e) => e.code === "invalid-source", bad);
  }
  for (const bad of ["..", "../x", "a/../../b", "a/.."]) {
    assert.throws(() => normalizePackagePath(bad), (e) => e.code === "path-escape", bad);
  }
  for (const bad of [42, [], {}, true]) {
    assert.throws(() => normalizePackagePath(bad), (e) => e.code === "invalid-source" && /must be a string/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => normalizePackagePath("/abs", { code: "invalid-lock" }), (e) => e.code === "invalid-lock");
});

test("git acquisition: default oas-package root, custom path, and explicit repository root", () => {
  const base = temp();
  // DEFAULT: no fragment selects oas-package/, never the repository root.
  const dflt = repoWithPackages(join(base, "default-repo"),
    { "oas-package": { manifest: { package: "d.pkg" }, capabilities: { cap: { capability: "d.cap" } } } },
    { "README.md": "repo docs\n", ".github/workflows/ci.yml": "ci\n" });
  const s1 = scope(base, "s1");
  const r1 = acquirePackage(s1, `file://${dflt}`);
  assert.equal(r1.root, "d.pkg");
  assert.equal(readPackageLocks(s1).packages["d.pkg"].path, "oas-package");

  // CUSTOM path.
  const custom = repoWithPackages(join(base, "custom-repo"),
    { "dist/oas": { manifest: { package: "c.pkg" }, capabilities: { cap: { capability: "c.cap" } } } });
  const s2 = scope(base, "s2");
  assert.equal(acquirePackage(s2, `file://${custom}#dist/oas`).root, "c.pkg");
  assert.equal(readPackageLocks(s2).packages["c.pkg"].path, "dist/oas");

  // EXPLICIT ROOT.
  const rootRepo = repoWithPackages(join(base, "root-repo"), { ".": { manifest: { package: "r.pkg" }, capabilities: { cap: { capability: "r.cap" } } } });
  const s3 = scope(base, "s3");
  assert.equal(acquirePackage(s3, `file://${rootRepo}#.`).root, "r.pkg");
  assert.equal(readPackageLocks(s3).packages["r.pkg"].path, ".", "root representation is canonical in the lock");

  // A repository whose package is ONLY at the root is not found by the default.
  const s4 = scope(base, "s4");
  assert.throws(() => acquirePackage(s4, `file://${rootRepo}`),
    (e) => e.code === "invalid-source" && /oas-package/.test(e.message) && /#\./.test(e.message));
  assert.ok(!existsSync(join(s4, OAS_LOCK_FILE)), "a failed selection writes no lock");
  rmSync(base, { recursive: true, force: true });
});

test("installed bytes equal the SELECTED subtree — repo docs, CI, souls and sibling packages stay outside", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"),
    { "oas-package": { manifest: { package: "sel.pkg" }, capabilities: { cap: { capability: "sel.cap" } } } },
    {
      "README.md": "repo docs\n", ".github/workflows/ci.yml": "ci\n",
      "agents/owner/soul/soul.yaml": "name: owner\n", "other-package/oas-package.json": "{}\n",
    });
  const s = scope(base);
  const r = acquirePackage(s, `file://${repo}`);
  const dir = r.installed[0].dir;
  assert.deepEqual(readdirSync(dir).sort(), ["cap", "oas-package.json"], "only the selected subtree is materialized");
  for (const outside of ["README.md", ".github", "agents", "other-package", ".git"]) {
    assert.ok(!existsSync(join(dir, outside)), `${outside} must not be installed`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("integrity covers the selected payload only: outside-root edits are invisible, payload and capability-agent edits are not", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"),
    { "oas-package": { manifest: { package: "int.pkg" }, capabilities: { cap: { capability: "int.cap", agents: ["agents/reviewer"] } } } },
    { "README.md": "v1\n" });
  write(join(repo, "oas-package", "cap", "agents", "reviewer", "soul.yaml"), "name: reviewer\ndescription: d\n");
  write(join(repo, "oas-package", "cap", "agents", "reviewer", "AGENTS.md"), "reviewer v1\n");
  gitCommit(repo, "agents");
  const s = scope(base);
  const baseline = acquirePackage(s, `file://${repo}`).installed[0].integrity;

  // OUTSIDE the selected root: neither installed bytes nor integrity move, so a
  // bare re-acquire is a clean no-op against the existing lock.
  write(join(repo, "README.md"), "v2 — totally different repository docs\n");
  write(join(repo, "unrelated", "notes.md"), "new sibling tree\n");
  gitCommit(repo, "outside");
  const s2 = scope(base, "s2");
  assert.equal(acquirePackage(s2, `file://${repo}`).installed[0].integrity, baseline, "changes outside the selected root do not move integrity");

  // INSIDE the payload — and inside a nested capability-agent soul — they do.
  const s3 = scope(base, "s3");
  write(join(repo, "oas-package", "cap", "agents", "reviewer", "AGENTS.md"), "reviewer v2 — TAMPERED\n");
  gitCommit(repo, "payload");
  assert.notEqual(acquirePackage(s3, `file://${repo}`).installed[0].integrity, baseline, "nested capability-agent changes move integrity");
  rmSync(base, { recursive: true, force: true });
});

test("two packages in one repository install side by side; one identity from two roots collides", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "mono"), {
    "packages/alpha": { manifest: { package: "mono.alpha" }, capabilities: { cap: { capability: "mono.a" } } },
    "packages/beta": { manifest: { package: "mono.beta" }, capabilities: { cap: { capability: "mono.b" } } },
  });
  const s = scope(base);
  acquirePackage(s, `file://${repo}#packages/alpha`);
  acquirePackage(s, `file://${repo}#packages/beta`);
  const locks = readPackageLocks(s).packages;
  assert.deepEqual([locks["mono.alpha"].path, locks["mono.beta"].path], ["packages/alpha", "packages/beta"]);
  assert.deepEqual(listInstalledPackages(s).map((p) => p.package).sort(), ["mono.alpha", "mono.beta"]);

  // Same OAS package identity from a second contained root is still a collision:
  // the dedup key is source AND selected path, so it cannot silently merge.
  const clash = repoWithPackages(join(base, "clash"), {
    "a": { manifest: { package: "clash.pkg" } },
    "b": { manifest: { package: "clash.pkg", dependencies: [] } },
    "root": { manifest: { package: "clash.root", dependencies: [] } },
  });
  const clashCommit = execFileSync("git", ["-C", clash, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  write(join(clash, "root", "oas-package.json"), JSON.stringify({
    package: "clash.root", version: "1.0.0", description: "p", compatibility: { oas: ">=0.1.0" },
    capabilities: [], dependencies: [`file://${clash}@${clashCommit}#a`, `file://${clash}@${clashCommit}#b`],
  }));
  gitCommit(clash, "deps");
  const s2 = scope(base, "s2");
  assert.throws(() => acquirePackage(s2, `file://${clash}#root`),
    (e) => e.code === "duplicate-package-identity" && e.provenance.every((p) => /#[ab]$/.test(p)));
  rmSync(base, { recursive: true, force: true });
});

test("payload-root selection fails atomically: traversal, missing manifest, non-directory, symlink escape, broken link", () => {
  const base = temp();
  const outside = join(base, "secret");
  write(join(outside, "oas-package.json"), JSON.stringify({ package: "evil.pkg", version: "1", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: [] }));
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "ok.pkg" }, capabilities: { cap: { capability: "ok.cap" } } } }, { "notes.md": "plain file\n" });
  symlinkSync(outside, join(repo, "escape"));
  symlinkSync(join(base, "nowhere"), join(repo, "dangling"));
  symlinkSync("oas-package", join(repo, "inside-link"));
  gitCommit(repo, "links");

  const cases = [
    ["../secret", "path-escape"],          // traversal never reaches the filesystem
    ["/etc", "invalid-source"],            // absolute paths are rejected at parse
    ["escape", "path-escape"],             // symlink out of the checkout
    ["dangling", "path-escape"],           // broken link fails closed, never "absent"
    ["notes.md", "invalid-source"],        // not a directory
    ["missing", "invalid-source"],         // absent
    ["oas-package/cap", "invalid-package-manifest"], // real dir, no manifest
  ];
  for (const [path, code] of cases) {
    const s = scope(base, `s-${path.replace(/[^a-z]/gi, "")}`);
    assert.throws(() => acquirePackage(s, `file://${repo}#${path}`), (e) => e.code === code, `${path} → ${code}`);
    assert.ok(!existsSync(join(s, OAS_LOCK_FILE)), `${path}: no lock written`);
    assert.ok(!existsSync(installedPackagesDir(s)), `${path}: no store mutation`);
  }
  // A CONTAINED symlink is followed like any other directory.
  const sOk = scope(base, "s-ok");
  assert.equal(acquirePackage(sOk, `file://${repo}#inside-link`).root, "ok.pkg");
  rmSync(base, { recursive: true, force: true });
});

test("source-layout mutation between inspection and acquisition fails before any store or lock write", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "mut.pkg" } } });
  const snap = inspectGitSourceRoot(`file://${repo}`);
  assert.deepEqual({ path: snap.path, payloadPackage: snap.payloadPackage, package: snap.package },
    { path: "oas-package", payloadPackage: true, package: false }, "inspection reports payload and root layout separately");
  try {
    // The remote moves its package root out from under the inspected snapshot.
    rmSync(join(repo, "oas-package", "oas-package.json"));
    write(join(repo, "oas-package", "oas.json"), JSON.stringify({ capability: "mut.cap", version: "1", description: "d" }));
    gitCommit(repo, "moved");
    const s = scope(base);
    // The snapshot is immutable: acquisition still installs the INSPECTED bytes.
    assert.equal(acquirePackage(s, `file://${repo}`, { rootSnapshot: snap }).installed[0].commit, snap.commit);
    // …and a snapshot whose payload layout no longer matches is rejected outright.
    const s2 = scope(base, "s2");
    assert.throws(() => acquirePackage(s2, `file://${repo}`, { rootSnapshot: { ...snap, payloadCapability: true } }),
      (e) => e.code === "invalid-source" && /layout changed/.test(e.message));
    assert.ok(!existsSync(join(s2, OAS_LOCK_FILE)));
  } finally { snap.cleanup(); }
  rmSync(base, { recursive: true, force: true });
});

test("lock path is strict: required, canonical, and '.' for local sources", () => {
  const sha = "a".repeat(40), integ = `sha256-${"0".repeat(64)}`;
  const git = (over) => ({ source: "git:https://h/x.git@v1", path: "oas-package", version: "1", commit: sha, integrity: integ, capabilities: [], ...over });
  assert.equal(validateLockEntry("p", git(), {}, {}), true);
  assert.equal(validateLockEntry("p", git({ path: "." }), {}, {}), true);
  const { path: _drop, ...noPath } = git();
  assert.throws(() => validateLockEntry("p", noPath, {}, {}), (e) => e.code === "invalid-lock" && /missing path/.test(e.message));
  // Never normalized or repaired on read — a non-canonical spelling is invalid.
  for (const bad of ["./sub", "sub/", "a//b", "a/./b"]) {
    assert.throws(() => validateLockEntry("p", git({ path: bad }), {}, {}), (e) => e.code === "invalid-lock" && /canonical/.test(e.message), bad);
  }
  for (const bad of ["/abs", "../x", "~/h", 7, null, ""]) {
    assert.throws(() => validateLockEntry("p", git({ path: bad }), {}, {}), (e) => e.code === "invalid-lock", JSON.stringify(bad));
  }
  // Local acquisition is exact-directory: only "." can be locked for it.
  assert.equal(validateLockEntry("p", git({ source: "path:/d", commit: "local", path: "." }), {}, {}), true);
  assert.throws(() => validateLockEntry("p", git({ source: "path:/d", commit: "local", path: "sub" }), {}, {}),
    (e) => e.code === "invalid-lock" && /exact directories/.test(e.message));
});

test("local package acquisition keeps exact-directory semantics for any root name", () => {
  const base = temp();
  // A directory that is NOT named oas-package is still the package root when
  // named directly — no default-path heuristic for local sources.
  const custom = pkgSource(join(base, "my-custom-root"), { package: "loc.pkg" }, { cap: { capability: "loc.cap" } });
  const s = scope(base);
  const r = acquirePackage(s, custom);
  assert.equal(r.root, "loc.pkg");
  const lock = readPackageLocks(s).packages["loc.pkg"];
  assert.deepEqual({ path: lock.path, commit: lock.commit, source: lock.source }, { path: ".", commit: "local", source: `path:${custom}` });
  // …and a local source that HAPPENS to contain oas-package/ still installs itself.
  const trap = pkgSource(join(base, "trap"), { package: "trap.pkg" });
  pkgSource(join(base, "trap", "oas-package"), { package: "trap.inner" });
  const s2 = scope(base, "s2");
  assert.equal(acquirePackage(s2, trap).root, "trap.pkg");
  rmSync(base, { recursive: true, force: true });
});

test("bare restore stays exact after the upstream package root moves; explicit update adopts and reports it", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "mv.pkg" }, capabilities: { cap: { capability: "mv.cap" } } } });
  const s = scope(base);
  const first = acquirePackage(s, `file://${repo}#oas-package`).installed[0];

  // Upstream moves the package to a different contained root and advances.
  execFileSync("git", ["-C", repo, "mv", "oas-package", "dist"]);
  write(join(repo, "dist", "extra.md"), "new payload file\n");
  gitCommit(repo, "moved root");

  // BARE RESTORE: the locked source+commit+path+integrity is what comes back,
  // even though the ref and the path both moved upstream.
  rmSync(join(installedPackagesDir(s), "mv.pkg"), { recursive: true, force: true });
  const restored = restorePackages(s).find((r) => r.package === "mv.pkg");
  assert.deepEqual({ status: restored.status, path: restored.path }, { status: "restored", path: "oas-package" });
  assert.equal(packageIntegrity(restored.dir), first.integrity, "restore reproduces the locked bytes exactly");
  assert.equal(readPackageLocks(s).packages["mv.pkg"].commit, first.commit, "restore never advances the ref");

  // Plain acquire may not move the locked root either.
  assert.throws(() => acquirePackage(s, `file://${repo}#dist`),
    (e) => e.code === "integrity-drift" && /package path "dist"/.test(e.message) && /oas update/.test(e.message));
  assert.equal(readPackageLocks(s).packages["mv.pkg"].path, "oas-package", "the refused acquire left the lock untouched");

  // Only an EXPLICIT update adopts the new root, and it reports the move.
  const upd = updatePackage(s, "mv.pkg", { spec: `file://${repo}#dist` });
  assert.deepEqual({ pathChanged: upd.pathChanged, before: upd.before.path, after: upd.after.path }, { pathChanged: true, before: "oas-package", after: "dist" });
  assert.equal(readPackageLocks(s).packages["mv.pkg"].path, "dist");
  const out = cli(s, "update", "mv.pkg", "--dir", s);
  assert.equal(out.status, 0, out.stderr);
  rmSync(base, { recursive: true, force: true });
});

test("update round-trips the selected root: git selection is sticky, a catalog may move its own", () => {
  const base = temp();
  // GIT: the user's selection survives an update that is not respelled.
  const repo = repoWithPackages(join(base, "repo"), { "sub/pkg": { manifest: { package: "st.pkg" } } });
  const s = scope(base);
  acquirePackage(s, `file://${repo}#sub/pkg`);
  write(join(repo, "sub", "pkg", "new.md"), "payload change\n");
  gitCommit(repo, "advance");
  const upd = updatePackage(s, "st.pkg");
  assert.deepEqual({ changed: upd.changed, pathChanged: upd.pathChanged, path: upd.after.path }, { changed: true, pathChanged: false, path: "sub/pkg" });

  // CATALOG: the catalog entry owns the path, so an update re-reads it.
  const cat = repoWithPackages(join(base, "cat"), { "v1": { manifest: { package: "cat.pkg" } }, "v2": { manifest: { package: "cat.pkg", version: "2.0.0" } } });
  const s2 = scope(base, "s2");
  let path = "v1";
  const catalog = (id) => (id === "cat.pkg" ? { url: cat, path } : undefined);
  acquirePackage(s2, "cat.pkg", { catalog });
  assert.equal(readPackageLocks(s2).packages["cat.pkg"].path, "v1");
  path = "v2";
  const cupd = updatePackage(s2, "cat.pkg", { catalog });
  assert.deepEqual({ pathChanged: cupd.pathChanged, before: cupd.before.path, after: cupd.after.path }, { pathChanged: true, before: "v1", after: "v2" });
  // …but a bare restore of that lock still installs the LOCKED path, not the catalog's.
  rmSync(join(installedPackagesDir(s2), "cat.pkg"), { recursive: true, force: true });
  path = "v1";
  const row = restorePackages(s2, { catalog }).find((r) => r.package === "cat.pkg");
  assert.deepEqual({ status: row.status, path: row.path }, { status: "restored", path: "v2" }, "a moved catalog path never changes a bare restore");
  rmSync(base, { recursive: true, force: true });
});

test("catalog entry paths are validated, and an invalid one fails before any mutation", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "cp.pkg" } } });
  // Absent catalog path falls back to the default contained root.
  const s = scope(base);
  acquirePackage(s, "cp.pkg", { catalog: () => ({ url: repo }) });
  assert.equal(readPackageLocks(s).packages["cp.pkg"].path, DEFAULT_PACKAGE_PATH);
  for (const [bad, code] of [["../out", "path-escape"], ["/abs", "invalid-source"], [42, "invalid-source"]]) {
    const bs = scope(base, `bad-${String(bad).replace(/[^a-z0-9]/gi, "")}`);
    assert.throws(() => acquirePackage(bs, "cp.pkg", { catalog: () => ({ url: repo, path: bad }) }),
      (e) => e.code === code && /catalog entry/.test(e.message), String(bad));
    assert.ok(!existsSync(join(bs, OAS_LOCK_FILE)));
  }
  rmSync(base, { recursive: true, force: true });
});

test("payload-root parity: trust, depsIntegrity, restore, JSON doctor and list all carry the selected path", () => {
  const base = temp();
  const repo = join(base, "repo");
  pkgSource(join(repo, "dist/pkg"), { package: "par.pkg" }, { cap: { capability: "par.cap", commands: { go: { exec: "go.mjs" } } } });
  write(join(repo, "dist/pkg", "cap", "go.mjs"), "// x\n");
  write(join(repo, "dist/pkg", "package.json"), JSON.stringify({ name: "par", version: "1.0.0", dependencies: {} }));
  write(join(repo, "dist/pkg", "package-lock.json"), JSON.stringify({ name: "par", lockfileVersion: 3, requires: true, packages: { "": { name: "par", version: "1.0.0" } } }));
  write(join(repo, "README.md"), "outside\n");
  gitify(repo);
  const s = scope(base);

  const inst = JSON.parse(cli(s, "install", `file://${repo}#dist/pkg`, "--dir", s, "--json").stdout);
  assert.equal(inst.ok, true, JSON.stringify(inst));
  assert.equal(inst.result.installed[0].path, "dist/pkg");

  const list = JSON.parse(cli(s, "list", "--dir", s, "--json").stdout);
  assert.equal(list.result.packages.find((p) => p.package === "par.pkg").path, "dist/pkg");
  const doc = JSON.parse(cli(s, "doctor", s, "--json").stdout);
  assert.equal(doc.packages.find((p) => p.id === "par.pkg").path, "dist/pkg");

  // Trust binds to the same package whether or not it sits at the repo root.
  const tr = JSON.parse(cli(s, "trust", "par.cap", "--dir", s, "--json").stdout);
  assert.equal(tr.ok, true, JSON.stringify(tr));
  const lock = readPackageLocks(s).packages["par.pkg"];
  assert.deepEqual({ path: lock.path, trusted: lock.trustedCapabilities }, { path: "dist/pkg", trusted: ["par.cap"] });
  assert.ok(Object.hasOwn(lock, "depsIntegrity") === (packageDepsIntegrity(join(installedPackagesDir(s), "par.pkg")) !== undefined));

  // Restore of the untouched artifact is an exact-path no-op.
  const rows = restorePackages(s).filter((r) => r.package === "par.pkg");
  assert.deepEqual(rows.map((r) => [r.status, r.path]), [["ok", "dist/pkg"]]);
  assert.deepEqual(readPackageLocks(s).packages["par.pkg"].trustedCapabilities, ["par.cap"], "restore preserves approvals");
  rmSync(base, { recursive: true, force: true });
});

test("payload roots never touch local capability development: owned/ and from: path: are unchanged", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    own.cap:\n      from: owned\n      global: true\n    dev.cap:\n      from: path:../devcap\n      global: true\n");
  write(join(s, ".agents/capabilities/owned/own.cap/oas.json"), JSON.stringify({ capability: "own.cap", version: "1.0.0", description: "owned" }));
  write(join(base, "devcap", "oas.json"), JSON.stringify({ capability: "dev.cap", version: "1.0.0", description: "dev" }));
  // External path capabilities stay lock-gated exactly as before — payload
  // roots never route them through package acquisition.
  writeCapabilityLock(s, "dev.cap", { source: `path:${join(base, "devcap")}`, version: "1.0.0", integrity: capabilityIntegrity(join(base, "devcap")) });
  const resolved = resolveOasConfig(s);
  assert.deepEqual(resolved.capabilities.map((c) => c.id).sort(), ["dev.cap", "own.cap"]);
  // Neither is a package source, so no package path or lock is involved at all.
  const lockText = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.equal(lockText.lockfileVersion, 1, "local capability development stays on the legacy capability lock — no package path involved");
  assert.equal(lockText.packages, undefined);
  rmSync(base, { recursive: true, force: true });
});

test("the DEFAULT catalog resolver honors the entry's path, and a malformed one fails closed (reviewer-da05e73)", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), {
    "dist/oas": { manifest: { package: "cat.def" }, capabilities: { cap: { capability: "cat.defcap" } } },
    "oas-package": { manifest: { package: "cat.decoy" } },
  });
  const catalogFile = join(base, "catalog.json");
  const prior = process.env.OAS_PACKAGE_CATALOG;
  process.env.OAS_PACKAGE_CATALOG = catalogFile;
  try {
    // The production resolver — NOT an injected fixture — must carry `path`
    // through, or every real catalog install silently gets the default root.
    write(catalogFile, JSON.stringify({ packages: { "cat.def": { url: repo, path: "dist/oas" } } }));
    const s = scope(base, "s1");
    assert.equal(acquirePackage(s, "cat.def").root, "cat.def");
    assert.equal(readPackageLocks(s).packages["cat.def"].path, "dist/oas");

    // Absent path still falls back to the default contained root.
    write(catalogFile, JSON.stringify({ packages: { "cat.decoy": { url: repo } } }));
    const s2 = scope(base, "s2");
    acquirePackage(s2, "cat.decoy");
    assert.equal(readPackageLocks(s2).packages["cat.decoy"].path, DEFAULT_PACKAGE_PATH);

    // A PRESENT but malformed path is a violation, never "absent" — a JSON
    // null must not fall through to the default.
    for (const [bad, code] of [[null, "invalid-source"], ["../out", "path-escape"], ["/abs", "invalid-source"], [7, "invalid-source"]]) {
      write(catalogFile, JSON.stringify({ packages: { "cat.def": { url: repo, path: bad } } }));
      const bs = scope(base, `bad-${String(bad).replace(/[^a-z0-9]/gi, "")}`);
      assert.throws(() => acquirePackage(bs, "cat.def"), (e) => e.code === code && /catalog entry/.test(e.message), JSON.stringify(bad));
      assert.ok(!existsSync(join(bs, OAS_LOCK_FILE)), `${JSON.stringify(bad)}: no lock written`);
    }
  } finally {
    if (prior === undefined) delete process.env.OAS_PACKAGE_CATALOG;
    else process.env.OAS_PACKAGE_CATALOG = prior;
  }
  assert.equal(normalizePackagePath(undefined), undefined, "only an ABSENT value defaults");
  assert.throws(() => normalizePackagePath(null), (e) => e.code === "invalid-source", "a present null is a violation, not a default");
  rmSync(base, { recursive: true, force: true });
});

test("lock sources parse against the exact normalized grammar — no downstream reclassification (reviewer-da05e73)", () => {
  const integ = `sha256-${"0".repeat(64)}`, sha = "a".repeat(40);
  const entry = (over) => ({ source: "git:https://h/x.git@v1", path: ".", version: "1", commit: sha, integrity: integ, capabilities: [], ...over });
  assert.equal(validateLockEntry("p", entry(), {}, {}), true);
  assert.equal(validateLockEntry("p", entry({ source: "catalog:oas.okf@v1.4.0" }), {}, {}), true);
  assert.equal(validateLockEntry("p", entry({ source: "catalog:oas.okf" }), {}, {}), true);
  assert.equal(validateLockEntry("p", entry({ source: "path:/abs/dir", commit: "local" }), {}, {}), true);
  assert.equal(validateLockEntry("p", entry({ source: "git:git@host:org/repo.git@v2" }), {}, {}), true);

  const rejected = [
    // A catalog id that is not a package identity would be RE-PARSED as a
    // local path by update and acquired from the operator's filesystem.
    "catalog:../evil", "catalog:/etc", "catalog:UPPER", "catalog:oas.okf@",
    // A relative path source is the same hole for the path kind.
    "path:../evil", "path:relative/dir", "path:",
    // A lock source never carries the selected root — it is the `path` field.
    "git:https://h/x.git@v1#sub", "catalog:oas.okf#sub", "path:/abs#sub",
    // Non-URL git payloads and empty halves.
    "git:", "git:not-a-url@v1", "git:https://h/x.git@",
  ];
  for (const source of rejected) {
    assert.throws(() => validateLockEntry("p", entry({ source, commit: source.startsWith("path:") ? "local" : sha }), {}, {}),
      (e) => e.code === "invalid-lock", source);
  }
});

test("a malformed lock source fails update/restore closed instead of acquiring a host directory (reviewer-da05e73)", () => {
  const base = temp();
  const s = scope(base);
  const evilName = "evil";
  const evil = pkgSource(join(base, evilName), { package: "cat.evil" });
  // Hand-written lock whose catalog source would re-parse as a relative path.
  writeFileSync(join(s, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 2,
    packages: { "cat.evil": { source: `catalog:../${evilName}`, path: ".", version: "1.0.0", commit: "a".repeat(40), integrity: packageIntegrity(evil), capabilities: [] } },
  }, null, 2));
  assert.throws(() => updatePackage(s, "cat.evil"), (e) => e.code === "invalid-lock");
  assert.throws(() => restorePackages(s), (e) => e.code === "invalid-lock");
  assert.throws(() => readPackageLocks(s), (e) => e.code === "invalid-lock");
  assert.ok(!existsSync(join(installedPackagesDir(s), "cat.evil")), "nothing acquired from the reclassified source");
  rmSync(base, { recursive: true, force: true });
});

test("a broken symlink at ANY depth of the package path is path-escape, not 'no package here' (reviewer-da05e73)", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "deep.pkg" } } });
  symlinkSync(join(base, "nowhere"), join(repo, "dangling"));
  mkdirSync(join(repo, "mid"), { recursive: true });
  symlinkSync(join(base, "nowhere"), join(repo, "mid", "broken"));
  symlinkSync(join(base, "outside-target"), join(repo, "mid", "out"));
  mkdirSync(join(base, "outside-target", "pkg"), { recursive: true });
  write(join(base, "outside-target", "pkg", "oas-package.json"), JSON.stringify({ package: "escaped.pkg", version: "1", description: "d", compatibility: { oas: ">=0.1.0" }, capabilities: [] }));
  gitCommit(repo, "links");

  for (const path of ["dangling", "dangling/sub", "mid/broken", "mid/broken/deeper", "mid/out/pkg"]) {
    const s = scope(base, `s-${path.replace(/[^a-z]/gi, "")}`);
    assert.throws(() => acquirePackage(s, `file://${repo}#${path}`), (e) => e.code === "path-escape", path);
    assert.ok(!existsSync(join(s, OAS_LOCK_FILE)), `${path}: no lock written`);
    assert.ok(!existsSync(installedPackagesDir(s)), `${path}: no store mutation`);
  }
  // A genuinely absent path is still "no package here", not a link failure.
  const sAbsent = scope(base, "s-absent");
  assert.throws(() => acquirePackage(sAbsent, `file://${repo}#mid/absent/deeper`), (e) => e.code === "invalid-source");
  rmSync(base, { recursive: true, force: true });
});

test("an @-bearing catalog selector round-trips through acquire, lock read and update (reviewer-39c11e1)", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "sel.pkg" } } });
  execFileSync("git", ["-C", repo, "tag", "release@candidate"]);
  const s = scope(base);
  // The catalog id charset excludes "@", so everything after the FIRST one is
  // the selector — a legitimate git ref spelling the writer does produce.
  const catalog = (id, selector) => (id === "sel.pkg" ? { url: repo, ref: selector, path: "oas-package" } : undefined);
  acquirePackage(s, "sel.pkg@release@candidate", { catalog });
  const locked = readPackageLocks(s).packages["sel.pkg"];
  assert.equal(locked.source, "catalog:sel.pkg@release@candidate", "the writer preserves the full selector");
  // …and every reader accepts what the writer produced.
  const { _file, _level, ...clean } = locked;
  assert.equal(validateLockEntry("sel.pkg", clean, { "sel.pkg": clean }, {}), true);
  assert.equal(restorePackages(s, { catalog }).find((r) => r.package === "sel.pkg").status, "ok");
  assert.equal(updatePackage(s, "sel.pkg", { catalog }).after.version, "1.0.0");
  assert.equal(readPackageLocks(s).packages["sel.pkg"].source, "catalog:sel.pkg@release@candidate", "update preserves the selector verbatim");
  rmSync(base, { recursive: true, force: true });
});

test("an option-like git ref is rejected, never silently resolved to HEAD (reviewer-39c11e1)", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "opt.pkg" } } });
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // `git checkout -q --detach` exits 0 WITHOUT selecting a revision, so a ref
  // reaching git as an option-capable argument would make acquisition report
  // whatever HEAD already was as the pinned commit.
  for (const ref of ["--detach", "--guess", "-q", "--orphan", "no-such-tag"]) {
    const s = scope(base, `s-${ref.replace(/[^a-z]/gi, "x")}`);
    assert.throws(() => acquirePackage(s, `file://${repo}@${ref}`), (e) => e.code === "invalid-source" && /does not resolve to a commit/.test(e.message), ref);
    assert.ok(!existsSync(join(s, OAS_LOCK_FILE)), `${ref}: no lock written`);
    assert.throws(() => inspectGitSourceRoot(`file://${repo}@${ref}`), (e) => e.code === "invalid-source", `inspect ${ref}`);
  }
  // A REMOTE manifest's dependency ref is the same untrusted input.
  const parent = pkgSource(join(base, "parent"), { package: "opt.parent", dependencies: [`file://${repo}@--detach#oas-package`] });
  const sDep = scope(base, "s-dep");
  assert.throws(() => acquirePackage(sDep, parent), (e) => e.code === "invalid-source" && /does not resolve to a commit/.test(e.message));

  // Real refs still work and land on the exact commit.
  const sOk = scope(base, "s-ok");
  assert.equal(acquirePackage(sOk, `file://${repo}@${head}`).installed[0].commit, head);
  rmSync(base, { recursive: true, force: true });
});

test("a short non-default remote branch name still resolves after a clone (reviewer-374647d)", () => {
  const base = temp();
  const repo = repoWithPackages(join(base, "repo"), { "oas-package": { manifest: { package: "br.pkg" } } });
  const defaultBranch = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  // A plain clone materializes ONLY the default branch locally; every other
  // branch exists solely as refs/remotes/origin/<name>, so `<name>` has to be
  // resolved through the remote-tracking ref.
  execFileSync("git", ["-C", repo, "checkout", "-qb", "feature"]);
  write(join(repo, "oas-package", "feature-only.md"), "on the feature branch\n");
  const featureCommit = gitCommit(repo, "feature work");
  execFileSync("git", ["-C", repo, "checkout", "-q", defaultBranch]);
  assert.notEqual(featureCommit, execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());

  const s = scope(base);
  const r = acquirePackage(s, `file://${repo}@feature`);
  assert.equal(r.installed[0].commit, featureCommit, "short remote branch resolves to its own commit, not the default branch");
  assert.ok(existsSync(join(r.installed[0].dir, "feature-only.md")), "the feature branch's payload is what got installed");
  assert.equal(readPackageLocks(s).packages["br.pkg"].source, `git:file://${repo}@feature`);

  // The fallback is a resolution path, not a relaxation: unknown and
  // option-like refs still fail closed.
  for (const ref of ["no-such-branch", "--detach"]) {
    const bs = scope(base, `s-${ref.replace(/[^a-z]/gi, "x")}`);
    assert.throws(() => acquirePackage(bs, `file://${repo}@${ref}`), (e) => e.code === "invalid-source" && /does not resolve to a commit/.test(e.message), ref);
  }
  // Inspection and the WS2 profile diff share the helper, so they agree.
  const snap = inspectGitSourceRoot(`file://${repo}@feature`);
  try { assert.equal(snap.commit, featureCommit); } finally { snap.cleanup(); }
  rmSync(base, { recursive: true, force: true });
});
