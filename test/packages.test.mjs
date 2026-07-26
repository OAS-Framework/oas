// Distribution package engine tests (docs/design/package-engine-contract.md).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  acquirePackage, applyLegacyLockMigration, approveCapability, capabilityManifests, capabilityManifest, capabilityTrust,
  capabilitySkillDirs, capabilityExecutablePath, listInstalledPackages, loadPackageManifestAt, migrateLegacyLock,
  materializePackageDeps, packageIntegrity, parsePackageSource, readPackageLocks, removePackage, resolveOasConfig, restorePackages,
  findAgent, spawnInstance, updatePackage, validateLockEntry, writeCapabilityLock, writePackageLock, installedPackagesDir, OAS_LOCK_FILE,
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
  write(join(dir, "oas-package.json"), JSON.stringify({ version: "1.0.0", description: "pkg", capabilities: caps, ...manifest }, null, 2));
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
  assert.deepEqual({ kind: cat.kind, id: cat.id, selector: cat.selector }, { kind: "catalog", id: "oas.okf", selector: "v1.4.0" });
  assert.equal(parsePackageSource("oas.okf").selector, undefined);
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
  write(join(d2, "oas-package.json"), JSON.stringify({ package: "a.esc2", version: "1.0.0", description: "d", capabilities: ["linked"] }));
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
  writePackageLock(outer, "a.pkg", { source: "path:/x", version: "1.0.0", commit: "local", integrity: "sha256-0", capabilities: ["a.cap"] });
  writePackageLock(inner, "a.pkg", { source: "path:/y", version: "2.0.0", commit: "local", integrity: "sha256-1", capabilities: ["a.cap"] });
  const locks = readPackageLocks(inner);
  assert.equal(locks.packages["a.pkg"].version, "2.0.0"); // closer wins
  assert.equal(readPackageLocks(outer).packages["a.pkg"].version, "1.0.0");
  // v1 file refuses package writes with legacy-lock
  const v1 = scope(base, "v1scope");
  writeCapabilityLock(v1, "old.cap", { source: "marketplace:old.cap@1.0.0", version: "1.0.0", integrity: "sha256-x" });
  assert.throws(() => writePackageLock(v1, "a.pkg", { source: "path:/z", version: "1", commit: "local", integrity: "sha256-2", capabilities: [] }), (e) => e.code === "legacy-lock");
  // legacy locks surface separately
  assert.equal(readPackageLocks(v1).legacy.length, 1);
  // deleting an entry
  writePackageLock(inner, "a.pkg", null);
  assert.equal(readPackageLocks(inner).packages["a.pkg"].version, "1.0.0"); // falls back to outer
  rmSync(base, { recursive: true, force: true });
});

test("writeCapabilityLock never downgrades a v2 lock (residue coexistence)", () => {
  const base = temp();
  const s = scope(base);
  writePackageLock(s, "a.pkg", { source: "path:/x", version: "1", commit: "local", integrity: "sha256-0", capabilities: [] });
  writeCapabilityLock(s, "legacy.cap", { source: "path:/y", version: "1", integrity: "sha256-1" });
  const parsed = JSON.parse(readFileSync(join(s, OAS_LOCK_FILE), "utf8"));
  assert.equal(parsed.lockfileVersion, 2);
  assert.ok(parsed.packages["a.pkg"]);
  assert.ok(parsed.capabilities["legacy.cap"]);
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
  const rootSrc = pkgSource(join(base, "root-src"), { package: "root.pkg", dependencies: [`file://${depSrc}@${depCommit}`] }, { "cap": { capability: "root.cap", commands: { run: { exec: "x.mjs" } } } });
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
  const unpinned = pkgSource(join(base, "u"), { package: "u.p", dependencies: [`file://${dep}`] });
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
  const catalog = (id) => (id === "oas.thing" ? { url: src } : undefined);
  const r = acquirePackage(s, "oas.thing", { catalog });
  assert.equal(r.root, "oas.thing");
  const lock = readPackageLocks(s).packages["oas.thing"];
  assert.ok(lock.source.startsWith("catalog:oas.thing@"));
  assert.deepEqual(lock.trustedCapabilities, []); // official identity grants NO executable trust
  assert.throws(() => acquirePackage(scope(base, "s2"), "not.in.catalog", { catalog }), (e) => e.code === "invalid-source");
  rmSync(base, { recursive: true, force: true });
});

test("acquirePackage: legacy v1 lock at the scope blocks package install with legacy-lock", () => {
  const base = temp();
  const s = scope(base);
  writeCapabilityLock(s, "old.cap", { source: "marketplace:old.cap@1", version: "1", integrity: "sha256-x" });
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
  acquirePackage(s, `file://${src}`);
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
  write(join(src, "oas-package.json"), JSON.stringify({ package: "u.p", version: "1.1.0", description: "pkg", capabilities: ["cap"] }));
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
  const root = pkgSource(join(base, "root"), { package: "rm.root", dependencies: [`file://${dep}@${depCommit}`] });
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
  assert.deepEqual(readPackageLocks(s).packages, {});
  rmSync(base, { recursive: true, force: true });
});

// ---------- migration ----------

test("migrateLegacyLock + applyLegacyLockMigration: marketplace→catalog mapping, residue retention, activation preserved", () => {
  const base = temp();
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    mig.cap:\n      from: installed\n      global: true\n");
  // official package for mig.cap available through a fixture catalog
  const official = pkgSource(join(base, "official"), { package: "mig.cap" }, { "cap": { capability: "mig.cap" } });
  gitify(official);
  const catalog = (id) => (id === "mig.cap" ? { url: official } : undefined);
  // v1 lock: one mappable marketplace entry, one unmappable
  writeCapabilityLock(s, "mig.cap", { source: "marketplace:mig.cap@1.0.0", version: "1.0.0", integrity: "sha256-a", trustedExecutables: true });
  writeCapabilityLock(s, "gone.cap", { source: "marketplace:gone.cap@1.0.0", version: "1.0.0", integrity: "sha256-b" });
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
  writeCapabilityLock(s, "g.cap", { source: "git:https://host/x.git", version: "1", commit: "abc", integrity: "sha256-x" });
  writeCapabilityLock(s, "p.cap", { source: "path:/some/dir", version: "1", integrity: "sha256-y" });
  const { plan } = migrateLegacyLock(s);
  assert.equal(plan.find((p) => p.capabilityId === "g.cap").package.spec, "https://host/x.git@abc");
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
  writeCapabilityLock(s, "x.cap", { source: "marketplace:x.cap@1.0.0", version: "1.0.0", integrity: "sha256-a" });
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
  writeCapabilityLock(s2, "old.cap", { source: "marketplace:old.cap@1", version: "1", integrity: "sha256-x" });
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
  const ok = { source: "git:https://h/x.git@v1", version: "1", commit: "a".repeat(40), integrity: `sha256-${"0".repeat(64)}`, capabilities: ["a.c"], dependencies: [], trustedCapabilities: ["a.c"] };
  assert.equal(validateLockEntry("p", ok, { p: ok }), true);
  assert.throws(() => validateLockEntry("p", { ...ok, trustedCapabilities: ["ghost"] }, {}), (e) => e.code === "invalid-lock");
  assert.throws(() => validateLockEntry("p", { ...ok, dependencies: ["missing.dep"] }, {}), (e) => e.code === "invalid-lock");
  assert.throws(() => validateLockEntry("p", { ...ok, commit: "shorty" }, {}), (e) => e.code === "invalid-lock");
  assert.throws(() => validateLockEntry("p", { ...ok, source: "path:/x" }, {}), (e) => e.code === "invalid-lock"); // path needs commit "local"
  assert.equal(validateLockEntry("p", { ...ok, source: "path:/x", commit: "local" }, {}), true);
  assert.throws(() => validateLockEntry("p", { ...ok, integrity: "sha256-xyz" }, {}), (e) => e.code === "invalid-lock");
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
  const rep = restorePackages(s);
  // present-at-integrity path also validates first
  assert.equal(rep.find((r) => r.package === "il.p").code, "invalid-lock");
  assert.throws(() => approveCapability(s, "il.cap"), (e) => e.code === "invalid-lock");
  rmSync(base, { recursive: true, force: true });
});

// ---------- package-runtime API v1 (docs/design/package-runtime-api.md) ----------

test("runtime API: version probe carries packageRuntimeApi", () => {
  const r = cli(process.cwd(), "version", "--json");
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.packageRuntimeApi, 1);
});

test("runtime API consumer fixture: agent show → upsert → config get → spawn attached, all through the CLI envelope", () => {
  const base = temp();
  // deployment: workspace with agents root + config with a layer setting
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: fixture\n");
  const root = join(ws, "agents");
  mkdirSync(root, { recursive: true });
  // owner instance home with a work tree (for --work attached)
  const repo = join(ws, "repo");
  write(join(repo, "README.md"), "r\n");
  gitify(repo);
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# Dev\n");
  symlinkSync("AGENTS.md", join(root, "dev", "soul", "CLAUDE.md"));
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  const owner = spawnInstance(root, findAgent(root, "dev"), { launch: false });
  // 1. agent show: absent → ok:true result:null
  let r = cli(ws, "agent", "show", "memory-harvest", "--dir", ws, "--json");
  let env = JSON.parse(r.stdout);
  assert.equal(env.ok, true);
  assert.equal(env.result, null);
  // 2. agent upsert with instructions
  const instr = join(base, "mh.md");
  write(instr, "# Memory harvester\n\nHarvest notes.\n");
  r = cli(ws, "agent", "upsert", "memory-harvest", "--instructions-file", instr, "--dir", ws, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.ok, true, r.stdout);
  assert.equal(env.result.created, true);
  // show now resolves
  r = cli(ws, "agent", "show", "memory-harvest", "--dir", ws, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.result.name, "memory-harvest");
  assert.equal(env.result.kind, "local");
  // 3. config get on a resolved value (name root) + null for unset paths + E_BAD_ARGS for unknown roots
  r = cli(ws, "config", "get", "name", "--dir", ws, "--json");
  assert.equal(JSON.parse(r.stdout).result.value, "fixture");
  r = cli(ws, "config", "get", "layers.knowledge.settings.harvest-model", "--dir", ws, "--json");
  assert.equal(JSON.parse(r.stdout).result.value, null);
  r = cli(ws, "config", "get", "nonsense.path", "--dir", ws, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_BAD_ARGS");
  // 4. spawn with exact --instance name, --ephemeral, attached to the owner work tree
  r = cli(ws, "spawn", "memory-harvest", "--instance", "memory-harvest-fixture", "--ephemeral", "--repo", repo,
    "--parent", owner.instance, "--work", "attached", "--work-dir", join(owner.home, "work"),
    "--task", "probe", "--no-launch", "--dir", ws, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.ok, true, r.stdout);
  assert.equal(env.result.instance, "memory-harvest-fixture");
  const meta = JSON.parse(readFileSync(join(env.result.home, "instance.json"), "utf8"));
  assert.equal(meta.kind, "capability", "--ephemeral overrides the on-disk kind");
  // --instance + --purpose is rejected
  r = cli(ws, "spawn", "memory-harvest", "--instance", "x", "--purpose", "y", "--no-launch", "--dir", ws, "--json");
  env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_BAD_ARGS");
  rmSync(base, { recursive: true, force: true });
});

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
  write(join(src, "oas-package.json"), JSON.stringify({ package: "flat.p", version: "1.0.0", description: "p", capabilities: ["."] }));
  gitify(src);
  acquirePackage(s, `file://${src}`);
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
  write(join(bad, "oas-package.json"), JSON.stringify({ package: "b.p", version: "1", description: "p", capabilities: [".", "sub"] }));
  assert.throws(() => loadPackageManifestAt(bad), (e) => e.code === "invalid-package-manifest" && /must be the only entry/.test(e.message));
  rmSync(base, { recursive: true, force: true });
});
