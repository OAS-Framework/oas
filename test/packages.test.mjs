import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveOasConfig, capabilityIntegrity } from "../lib/core.mjs";
import {
  acquirePackage, aggregateMissingRequirements, commandOnPath, diffConfigTexts, discoverWorkspaceScopes,
  loadPackageManifest, lockedPackageCapabilities, normalizeRequirement, packageCapabilityIds,
  parseProfileProvenance, profileProvenanceHeader, readPackageLocks, requirementInstallPlan,
  resolvePackageSource, runRequirementInstall, selectProfile, validateProfile, packageSlug,
  installedPackagesDir,
} from "../lib/packages.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
function temp() { return mkdtempSync(join(tmpdir(), "oas-pkg-test-")); }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function cli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...opts });
}
function gitRepo(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
}

/** Contract-level fixture package (per the Decision's oas-package.json shape). */
function fixturePackage(dir, { id = "example.engineering", configs, capabilities, dependencies, extraFiles = {} } = {}) {
  const caps = capabilities ?? {
    "capabilities/example-review": { capability: "example.review", version: "1.0.0", description: "Review capability." },
    "capabilities/example-delivery": { capability: "example.delivery", version: "1.0.0", description: "Delivery capability.", layer: "knowledge" },
  };
  for (const [rel, manifest] of Object.entries(caps)) write(join(dir, rel, "oas.json"), JSON.stringify(manifest, null, 2));
  const cfgs = configs ?? {
    default: { path: "configs/default/oas-config.yaml", description: "Recommended workspace setup", default: true },
    minimal: { path: "configs/minimal/oas-config.yaml", description: "Knowledge only" },
  };
  write(join(dir, "oas-package.json"), JSON.stringify({
    package: id, version: "1.0.0", description: "Fixture package.",
    compatibility: { oas: ">=0.6.2" },
    capabilities: Object.keys(caps),
    configs: cfgs,
    ...(dependencies ? { dependencies } : {}),
  }, null, 2));
  write(join(dir, "configs/default/oas-config.yaml"),
    `name: workspace\n\nagent-types:\n  reviewers:\n    description: review family\n\ncapabilities:\n  layers:\n    knowledge:\n      capability: example.delivery\n      from: installed\n  additive:\n    example.review:\n      from: installed\n      agent-types:\n        reviewers: true\n`);
  write(join(dir, "configs/minimal/oas-config.yaml"),
    `name: workspace\n\ncapabilities:\n  layers:\n    knowledge:\n      capability: example.delivery\n      from: installed\n`);
  for (const [rel, body] of Object.entries(extraFiles)) write(join(dir, rel), body);
  return dir;
}

/** Simulate the engine's install: package store dir + lock v2 entry (phase-1 fixture). */
function installFixturePackage(scope, pkgDir, { id = "example.engineering", capabilities = ["example.review", "example.delivery"], dependencies = [] } = {}) {
  const dest = join(scope, ".agents", "packages", "installed", packageSlug(id));
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync("cp", ["-R", pkgDir, dest]);
  const lockFile = join(scope, "oas-lock.json");
  const parsed = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")) : { lockfileVersion: 2, packages: {} };
  parsed.lockfileVersion = 2; parsed.packages ||= {};
  parsed.packages[id] = {
    source: `path:${pkgDir}`, version: "1.0.0", commit: "local",
    integrity: capabilityIntegrity(dest),
    capabilities, dependencies, trustedCapabilities: [],
  };
  writeFileSync(lockFile, JSON.stringify(parsed, null, 2) + "\n");
  return dest;
}

// ---------- manifest ----------

test("package manifest loads, validates, and rejects escapes and bad shapes", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const m = loadPackageManifest(pkg);
  assert.equal(m.package, "example.engineering");
  assert.deepEqual(packageCapabilityIds(m).sort(), ["example.delivery", "example.review"]);

  // absolute / .. paths rejected (contract error codes)
  write(join(base, "bad1", "oas-package.json"), JSON.stringify({ package: "bad.pkg", version: "1", description: "x", capabilities: ["../escape"] }));
  assert.throws(() => loadPackageManifest(join(base, "bad1")), (e) => e.code === "path-escape" && /must stay inside the package/.test(e.message));
  write(join(base, "bad2", "oas-package.json"), JSON.stringify({ package: "bad.pkg", version: "1", description: "x", configs: { a: { path: "/etc/passwd" } } }));
  assert.throws(() => loadPackageManifest(join(base, "bad2")), (e) => e.code === "path-escape");
  // multiple defaults rejected
  write(join(base, "bad3", "oas-package.json"), JSON.stringify({ package: "bad.pkg", version: "1", description: "x", configs: { a: { path: "a.yaml", default: true }, b: { path: "b.yaml", default: true } } }));
  assert.throws(() => loadPackageManifest(join(base, "bad3")), (e) => e.code === "invalid-package-manifest" && /multiple default/.test(e.message));
  // symlink escape caught after resolution
  const pkg2 = join(base, "pkg2");
  write(join(pkg2, "oas-package.json"), JSON.stringify({ package: "sneaky.pkg", version: "1", description: "x", configs: { a: { path: "link/oas-config.yaml" } } }));
  write(join(base, "outside", "oas-config.yaml"), "name: outside\n");
  symlinkSync(join(base, "outside"), join(pkg2, "link"));
  assert.throws(() => loadPackageManifest(pkg2), (e) => e.code === "path-escape" && /escapes the package after symlink resolution/.test(e.message));
  // invalid package id charset (contract: ^[a-z0-9][a-z0-9._-]*$)
  write(join(base, "bad4", "oas-package.json"), JSON.stringify({ package: "Bad_Pkg", version: "1", description: "x" }));
  assert.throws(() => loadPackageManifest(join(base, "bad4")), (e) => e.code === "invalid-package-manifest");
  // valid JSON that is not an object (null, array) still carries the stable code
  write(join(base, "bad5", "oas-package.json"), "null");
  assert.throws(() => loadPackageManifest(join(base, "bad5")), (e) => e.code === "invalid-package-manifest" && /must be a JSON object/.test(e.message));
  write(join(base, "bad6", "oas-package.json"), "[]");
  assert.throws(() => loadPackageManifest(join(base, "bad6")), (e) => e.code === "invalid-package-manifest");
});

test("packageCapabilityIds routes declared-resource failures through invalid-package-manifest", () => {
  const base = temp();
  // declared capability dir without oas.json
  const p1 = fixturePackage(join(base, "p1"), { id: "p1.pkg", capabilities: {} });
  const m1 = { ...loadPackageManifest(p1), capabilities: ["capabilities/ghost"] };
  mkdirSync(join(p1, "capabilities", "ghost"), { recursive: true });
  assert.throws(() => packageCapabilityIds(m1), (e) => e.code === "invalid-package-manifest" && /has no oas\.json/.test(e.message));
  // malformed capability oas.json
  write(join(p1, "capabilities", "ghost", "oas.json"), "{not json");
  assert.throws(() => packageCapabilityIds(m1), (e) => e.code === "invalid-package-manifest" && /invalid JSON/.test(e.message));
  // valid JSON but null / missing capability id
  write(join(p1, "capabilities", "ghost", "oas.json"), "null");
  assert.throws(() => packageCapabilityIds(m1), (e) => e.code === "invalid-package-manifest");
  write(join(p1, "capabilities", "ghost", "oas.json"), JSON.stringify({ version: "1" }));
  assert.throws(() => packageCapabilityIds(m1), (e) => e.code === "invalid-package-manifest" && /has no "capability"/.test(e.message));
});

test("packageSlug: slug equals the identity for the contract charset", () => {
  assert.equal(packageSlug("example.engineering"), "example.engineering");
  assert.equal(packageSlug("oas.okf"), "oas.okf");
});

// ---------- profile selection ----------

test("profile selection: marked default, single profile, explicit name, multiple unmarked require a choice", () => {
  const base = temp();
  const m = loadPackageManifest(fixturePackage(join(base, "pkg")));
  assert.equal(selectProfile(m).name, "default");
  assert.equal(selectProfile(m, "minimal").name, "minimal");
  assert.throws(() => selectProfile(m, "nope"), /no config profile "nope"/);

  const single = loadPackageManifest(fixturePackage(join(base, "single"), { configs: { only: { path: "configs/default/oas-config.yaml" } } }));
  assert.equal(selectProfile(single).name, "only");

  const multi = loadPackageManifest(fixturePackage(join(base, "multi"), { configs: {
    a: { path: "configs/default/oas-config.yaml" }, b: { path: "configs/minimal/oas-config.yaml" },
  } }));
  assert.throws(() => selectProfile(multi), /none marked default.*--config/s);

  const none = loadPackageManifest(fixturePackage(join(base, "none"), { configs: {} }));
  assert.throws(() => selectProfile(none), (e) => e.code === "E_NO_PROFILES" && /exports no config profiles/.test(e.message));
  // typed codes on the other selection failures
  assert.throws(() => selectProfile(multi), (e) => e.code === "E_PROFILE_AMBIGUOUS");
  assert.throws(() => selectProfile(m, "nope"), (e) => e.code === "E_PROFILE_NOT_FOUND");
});

// ---------- profile validation ----------

test("profile validation: schema, dependency closure, layer agreement, agent types, path escapes", () => {
  const base = temp();
  const m = loadPackageManifest(fixturePackage(join(base, "pkg")));
  assert.deepEqual(validateProfile(m, selectProfile(m)), []);

  // capability not supplied by package or dependency closure
  const orphan = loadPackageManifest(fixturePackage(join(base, "orphan"), { extraFiles: {
    "configs/orphan/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    ghost.cap:\n      from: installed\n      global: true\n",
  }, configs: { orphan: { path: "configs/orphan/oas-config.yaml", default: true } } }));
  const errs1 = validateProfile(orphan, selectProfile(orphan));
  assert.ok(errs1.some((e) => /ghost\.cap is not supplied/.test(e)), errs1.join("; "));
  // ... but a dependency-supplied capability passes
  assert.deepEqual(validateProfile(orphan, selectProfile(orphan), { dependencyCapabilities: ["ghost.cap"] }), []);

  // layer disagreement with the capability manifest
  const wrongLayer = loadPackageManifest(fixturePackage(join(base, "wrong-layer"), { extraFiles: {
    "configs/w/oas-config.yaml": "name: w\ncapabilities:\n  layers:\n    messaging:\n      capability: example.delivery\n      from: installed\n",
  }, configs: { w: { path: "configs/w/oas-config.yaml", default: true } } }));
  const errs2 = validateProfile(wrongLayer, selectProfile(wrongLayer));
  assert.ok(errs2.some((e) => /layer messaging binds example\.delivery, but its manifest declares layer "knowledge"/.test(e)), errs2.join("; "));

  // syntactically invalid agent type
  const badType = loadPackageManifest(fixturePackage(join(base, "bad-type"), { extraFiles: {
    "configs/t/oas-config.yaml": "name: w\nagent-types:\n  Bad_Type:\n    description: nope\n",
  }, configs: { t: { path: "configs/t/oas-config.yaml", default: true } } }));
  assert.ok(validateProfile(badType, selectProfile(badType)).some((e) => /agent type "Bad_Type"/.test(e)));

  // schema-invalid profile (unknown top-level key)
  const badSchema = loadPackageManifest(fixturePackage(join(base, "bad-schema"), { extraFiles: {
    "configs/s/oas-config.yaml": "name: w\ntotally-unknown-key: 1\n",
  }, configs: { s: { path: "configs/s/oas-config.yaml", default: true } } }));
  assert.ok(validateProfile(badSchema, selectProfile(badSchema)).some((e) => /unsupported oas-config key/.test(e)));

  // paths escaping the target scope
  const escape = loadPackageManifest(fixturePackage(join(base, "escape"), { extraFiles: {
    "configs/e/oas-config.yaml": "name: w\ncapabilities:\n  layers:\n    knowledge:\n      capability: example.delivery\n      from: installed\n      injection-override: ../../outside.md\nwork-modes:\n  worktree:\n    setup: /usr/bin/evil\n",
  }, configs: { e: { path: "configs/e/oas-config.yaml", default: true } } }));
  const errs3 = validateProfile(escape, selectProfile(escape));
  assert.ok(errs3.some((e) => /injection-override escapes the target scope/.test(e)), errs3.join("; "));
  assert.ok(errs3.some((e) => /work-modes\.worktree\.setup escapes/.test(e)), errs3.join("; "));

  // profiles must not reference host paths
  const hostPath = loadPackageManifest(fixturePackage(join(base, "host-path"), { extraFiles: {
    "configs/h/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    x.cap:\n      from: path:/abs/dir\n      global: true\n",
  }, configs: { h: { path: "configs/h/oas-config.yaml", default: true } } }));
  assert.ok(validateProfile(hostPath, selectProfile(hostPath)).some((e) => /must reference installed capabilities, not host paths/.test(e)));
});

// ---------- init --package (CLI) ----------

test("oas init --package: previews, validates, snapshots with provenance; default and explicit profiles; overwrite refusal", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);

  const r = cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /profile "default"/);
  assert.match(r.stdout, /exports capabilities: example\.review, example\.delivery/);
  const file = join(ws, "oas-config.yaml");
  const text = readFileSync(file, "utf8");
  assert.match(text, /^# package: example\.engineering@\S+ profile: default \(snapshot/);
  assert.match(text, /capability: example\.delivery/);
  // name rewritten to the target scope
  assert.match(text, new RegExp(`^name: ws$`, "m"));
  const prov = parseProfileProvenance(text);
  assert.equal(prov.package, "example.engineering");
  assert.equal(prov.profile, "default");

  // refusal to overwrite an existing config
  const r2 = cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /already exists/);
  assert.equal(readFileSync(file, "utf8"), text, "existing snapshot must not be rewritten");

  // explicit profile choice
  const ws2 = join(base, "ws2"); mkdirSync(ws2);
  const r3 = cli(["init", "--package", pkg, "--config", "minimal", "--dir", ws2, "--no-tmux-mouse"]);
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(readFileSync(join(ws2, "oas-config.yaml"), "utf8"), /profile: minimal/);

  // multiple unmarked profiles require --config
  const multiPkg = fixturePackage(join(base, "multi"), { id: "multi.pkg", configs: {
    a: { path: "configs/default/oas-config.yaml" }, b: { path: "configs/minimal/oas-config.yaml" },
  } });
  const ws3 = join(base, "ws3"); mkdirSync(ws3);
  const r4 = cli(["init", "--package", multiPkg, "--dir", ws3, "--no-tmux-mouse"]);
  assert.equal(r4.status, 1);
  assert.match(r4.stderr, /--config/);
  assert.equal(existsSync(join(ws3, "oas-config.yaml")), false);

  // invalid profile refuses to snapshot
  const badPkg = fixturePackage(join(base, "bad"), { id: "bad.pkg", extraFiles: {
    "configs/x/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    ghost.cap:\n      from: installed\n      global: true\n",
  }, configs: { x: { path: "configs/x/oas-config.yaml", default: true } } });
  const ws4 = join(base, "ws4"); mkdirSync(ws4);
  const r5 = cli(["init", "--package", badPkg, "--dir", ws4, "--no-tmux-mouse"]);
  assert.equal(r5.status, 1);
  assert.match(r5.stderr, /failed validation/);
  assert.equal(existsSync(join(ws4, "oas-config.yaml")), false);
});

// ---------- adopter sovereignty ----------

test("adopted snapshot stays an ordinary scoped config: retarget, disable, settings, and nested repo overrides all work", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);
  assert.equal(cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]).status, 0);
  // Make the package capabilities discoverable at the scope like the engine would
  // (owned/ store is the phase-1 stand-in for installed package indexing).
  for (const [folder, id, layer] of [["example-review", "example.review", undefined], ["example-delivery", "example.delivery", "knowledge"]]) {
    write(join(ws, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({ capability: id, version: "1.0.0", description: "x", ...(layer ? { layer } : {}) }));
  }
  // snapshot must be editable: from: installed → owned to match the fixture store
  const file = join(ws, "oas-config.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("from: installed", "from: owned"));

  const resolved = resolveOasConfig(ws, undefined);
  assert.equal(resolved.layers.knowledge.id, "example.delivery");

  // adopter freedom: disable the profile-enabled layer capability
  const wsOff = readFileSync(file, "utf8");
  writeFileSync(file, wsOff.replace("    knowledge:\n      capability: example.delivery\n      from: owned", "    knowledge: none"));
  assert.equal(resolveOasConfig(ws, undefined).layers.knowledge, undefined);
  writeFileSync(file, wsOff); // restore

  // adopter freedom: retarget + settings via `oas use`
  const r = cli(["use", "example.review", "--global", "--settings", "tone=direct", "--dir", ws]);
  assert.equal(r.status, 0, r.stderr);
  const after = resolveOasConfig(ws, undefined).capabilities.find((c) => c.id === "example.review");
  assert.ok(after, "retargeted capability resolves globally");
  assert.equal(after.settings.tone, "direct");

  // nested repository override: closer scope disables the workspace layer
  const repo = join(ws, "member"); mkdirSync(repo, { recursive: true });
  write(join(repo, "oas-config.yaml"), "name: member\ncapabilities:\n  layers:\n    knowledge: none\n");
  assert.equal(resolveOasConfig(repo, undefined).layers.knowledge, undefined, "nested repo override wins");
  assert.equal(resolveOasConfig(ws, undefined).layers.knowledge.id, "example.delivery", "workspace scope unaffected");
});

// ---------- config diff ----------

test("oas config diff is report-only: shows drift, never merges or overwrites", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);
  assert.equal(cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]).status, 0);
  const file = join(ws, "oas-config.yaml");
  const adopted = readFileSync(file, "utf8");

  // no drift beyond the rewritten name line
  const same = cli(["config", "diff", "--package", pkg, "--dir", ws]);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /report only/);

  // local edit shows as drift; file untouched by diff
  writeFileSync(file, adopted + "  # local note\n");
  const r = cli(["config", "diff", "--package", pkg, "--config", "default", "--dir", ws]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+   # local note/);
  assert.match(r.stdout, /differing line/);
  assert.equal(readFileSync(file, "utf8"), adopted + "  # local note\n", "diff must not write");

  // provenance header supplies package/profile defaults — and since Gate 1,
  // init --package <path> locks the closure, so the id resolves via the lock
  const r2 = cli(["config", "diff", "--dir", ws]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /report only/);
});

test("diffConfigTexts produces a minimal line diff", () => {
  const d = diffConfigTexts("a\nb\nc\n", "a\nx\nc\n");
  assert.deepEqual(d, [
    { kind: "same", line: "a" }, { kind: "local", line: "b" }, { kind: "package", line: "x" }, { kind: "same", line: "c" },
  ]);
});

// ---------- lock v2 reading ----------

test("lock v2 packages map is read scope-wise (contract envelope) and supplies capability provenance", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\n");
  installFixturePackage(ws, pkg);
  const locks = readPackageLocks(ws);
  assert.ok(locks.packages["example.engineering"]);
  assert.equal(locks.packages["example.engineering"].version, "1.0.0");
  assert.deepEqual(locks.legacy, []);
  const supplied = lockedPackageCapabilities(ws);
  assert.deepEqual(supplied.get("example.review"), ["example.engineering"]);
  // v1 lock files without packages: are tolerated and surfaced as legacy, untouched
  const ws2 = join(base, "ws2");
  write(join(ws2, "oas-config.yaml"), "name: ws2\n");
  write(join(ws2, "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: { "old.cap": { source: "marketplace:old.cap@1.0.0", version: "1.0.0", integrity: `sha256-${"0".repeat(64)}` } } }));
  const r2 = readPackageLocks(ws2);
  assert.deepEqual(r2.packages, {});
  assert.equal(r2.legacy.length, 1);
  assert.ok(r2.legacy[0].capabilities["old.cap"]);
  // an EMPTY v1 lock still surfaces as legacy — consumers must see the scope
  // carries a legacy lock even when its capabilities map is empty
  const ws3 = join(base, "ws3");
  write(join(ws3, "oas-config.yaml"), "name: ws3\n");
  write(join(ws3, "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: {} }));
  const r3 = readPackageLocks(ws3);
  assert.equal(r3.legacy.length, 1, "empty v1 lock must not disappear from the envelope");
  assert.deepEqual(r3.legacy[0].capabilities, {});
  assert.equal(r3.legacy[0].level, ws3);
});

test("resolvePackageSource resolves installed package ids and local paths; unknown ids get a pointed error", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\n");
  installFixturePackage(ws, pkg);
  const byId = resolvePackageSource("example.engineering", ws);
  assert.equal(byId.manifest.package, "example.engineering");
  assert.equal(byId.commit, "local");
  const byPath = resolvePackageSource(pkg, ws);
  assert.equal(byPath.manifest.package, "example.engineering");
  assert.throws(() => resolvePackageSource("no.such.pkg", ws), (e) => e.code === "invalid-source" && /not a locked package id/.test(e.message));
});

// ---------- workspace scope discovery (bounded scans) ----------

test("discoverWorkspaceScopes: deterministic path order with pruning of stores, vendor dirs, instances, and nested team boundaries", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // member scopes, discovered in path order
  write(join(ws, "b-repo", "oas-config.yaml"), "name: b\n");
  write(join(ws, "a-repo", "oas-lock.json"), "{}");
  write(join(ws, "a-repo", "nested", "oas-config.yaml"), "name: nested\n");
  // pruned: .git, node_modules, vendor, .agents stores, local-agents, agent instances
  write(join(ws, ".git", "oas-config.yaml"), "name: git\n");
  write(join(ws, "node_modules", "dep", "oas-config.yaml"), "name: dep\n");
  write(join(ws, "vendor", "oas-config.yaml"), "name: vendor\n");
  write(join(ws, ".agents", "packages", "installed", "p", "oas-config.yaml"), "name: store\n");
  write(join(ws, "local-agents", "x", "oas-config.yaml"), "name: local\n");
  write(join(ws, "agents", "dev", "soul", "soul.yaml"), "name: dev\n");
  write(join(ws, "agents", "dev", "instances", "dev-1", "work", "oas-config.yaml"), "name: worktree\n");
  // nested team boundary: its own reconciliation unit, not descended into or included
  write(join(ws, "other-team", "oas-config.yaml"), "name: other\nteam:\n  name: t2\n");
  write(join(ws, "other-team", "inner", "oas-config.yaml"), "name: inner\n");

  const scopes = discoverWorkspaceScopes(ws);
  assert.deepEqual(scopes, [join(ws, "a-repo"), join(ws, "a-repo", "nested"), join(ws, "b-repo")]);
});

test("bare oas install: non-team scope keeps current-chain behavior and never scans downward", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\n"); // no team:
  write(join(ws, "child", "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: { "ghost.cap": { source: "path:/nonexistent", integrity: "sha256-x" } } }));
  const r = cli(["install", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /reconciliation boundary/);
  assert.doesNotMatch(r.stdout, /ghost\.cap/, "must not descend into child scopes without a team boundary");
});

test("bare oas install at a team boundary prints the boundary FIRST, restores each scope once, and aggregates failures by scope", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // a descendant scope with an unrestorable lock
  write(join(ws, "member", "oas-config.yaml"), "name: member\n");
  write(join(ws, "member", "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: { "ghost.cap": { source: "path:/nonexistent-src", integrity: "sha256-x" } } }));
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^Workspace reconciliation boundary: /m);
  assert.ok(r.stdout.indexOf("reconciliation boundary") < r.stdout.indexOf("ghost.cap"), "boundary printed before restore work");
  assert.match(r.stdout, /FAILED\s+ghost\.cap/);
  assert.match(r.stdout, /Failures by scope:/);
  assert.match(r.stdout, /member.*ghost\.cap/);
  // Each lock level's graph is processed once: the failing member lock reports
  // exactly one FAILED line even though the boundary and the member scope are
  // both reconciled (restoreCapabilities' ancestor walk must not repeat levels).
  assert.equal(r.stdout.split("ghost.cap").length - 1, 2, `one FAILED line + one failures-by-scope line:\n${r.stdout}`);
});

test("reconciliation restores a missing locked package from its exact source and fails clearly on integrity drift", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // package lock with a WRONG integrity: restore attempts, verifies, fails — never silent success
  write(join(ws, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: { "example.engineering": {
    source: `path:${pkg}`, version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`,
    capabilities: ["example.review", "example.delivery"], dependencies: [], trustedCapabilities: [],
  } } }, null, 2));
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1, `integrity drift must fail reconciliation:\n${r.stdout}`);
  assert.match(r.stdout, /FAILED\s+package example\.engineering\s+restored tree .* does not match locked/);
  assert.match(r.stdout, /Failures by scope:/);
  assert.equal(existsSync(join(ws, ".agents", "packages", "installed", "example.engineering", "oas-package.json")), false, "failed restore must not leave the artifact");
  // with the CORRECT locked integrity, the missing artifact restores exactly
  const trueDest = installFixturePackage(join(base, "probe"), pkg); // compute true integrity via the fixture helper
  const integrity = JSON.parse(readFileSync(join(base, "probe", "oas-lock.json"), "utf8")).packages["example.engineering"].integrity;
  void trueDest;
  write(join(ws, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: { "example.engineering": {
    source: `path:${pkg}`, version: "1.0.0", commit: "local", integrity,
    capabilities: ["example.review", "example.delivery"], dependencies: [], trustedCapabilities: [],
  } } }, null, 2));
  const r2 = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.match(r2.stdout, /restored\s+package example\.engineering/);
  assert.ok(existsSync(join(ws, ".agents", "packages", "installed", "example.engineering", "oas-package.json")));
  // present + matching → ok on the next run
  const r3 = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r3.status, 0);
  assert.match(r3.stdout, /ok\s+package example\.engineering/);
  // capability-list mismatch fails closed
  const lock = JSON.parse(readFileSync(join(ws, "oas-lock.json"), "utf8"));
  lock.packages["example.engineering"].capabilities = ["example.review"]; // wrong list
  writeFileSync(join(ws, "oas-lock.json"), JSON.stringify(lock, null, 2));
  rmSync(join(ws, ".agents", "packages"), { recursive: true, force: true });
  const r4 = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r4.status, 1);
  assert.match(r4.stdout, /disagree with restored manifest/);
});

test("non-team bare install also verifies v2 package locks (chain path, no boundary)", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\n"); // NO team:
  write(join(ws, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: { "example.engineering": {
    source: `path:${pkg}`, version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`,
    capabilities: ["example.review", "example.delivery"], dependencies: [], trustedCapabilities: [],
  } } }, null, 2));
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1, `non-team scope with a missing locked package must fail:\n${r.stdout}`);
  assert.match(r.stdout, /FAILED\s+package example\.engineering/);
  assert.doesNotMatch(r.stdout, /Nothing to restore/);
  // ancestor package locks are checked at a team boundary too
  const outer = join(base, "outer");
  const inner = join(outer, "team");
  write(join(outer, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: { "example.engineering": {
    source: `path:${pkg}`, version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`,
    capabilities: ["example.review"], dependencies: [], trustedCapabilities: [],
  } } }, null, 2));
  write(join(inner, "oas-config.yaml"), "name: team\nteam:\n  name: t\n");
  const r2 = cli(["install", "--no-requirements", "--dir", inner], { cwd: inner });
  assert.equal(r2.status, 1, `ancestor package lock must be checked at a team boundary:\n${r2.stdout}`);
  assert.match(r2.stdout, /FAILED\s+package example\.engineering/);
  // with the artifact installed, everything is ok again
  installFixturePackage(ws, pkg);
  const r3 = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r3.status, 0, `${r3.stdout}\n${r3.stderr}`);
  assert.match(r3.stdout, /ok\s+package example\.engineering/);
});

test("nested descendants do not retry an ancestor's FAILED restore: acquisition attempts counted via a recording cp shim", () => {
  const base = temp();
  // A restorable path source — but locked with a WRONG integrity, so every
  // restore attempt copies (cp), fails integrity verification, and removes the
  // artifact again. Each retry is one observable cp call.
  const src = join(base, "src");
  write(join(src, "oas.json"), JSON.stringify({ capability: "acme.cap", version: "1.0.0", description: "x", compatibility: { oas: ">=0.6.2" } }));
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // Log path travels via env var and a quoted redirect — robust against TMPDIRs
  // containing spaces or shell metacharacters.
  write(join(bin, "cp"), `#!/bin/sh\necho "cp $@" >> "$CP_LOG"\nexec /bin/cp "$@"\n`);
  chmodSync(join(bin, "cp"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CP_LOG: join(base, "cp-log.txt") };

  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // The failing lock lives at an intermediate discovered scope with NESTED
  // descendants below it — the pre-dedupe implementation re-walked (and
  // re-attempted) this level once per nested descendant, hiding the retries
  // behind its report filter.
  const mid = join(ws, "member");
  write(join(mid, "oas-config.yaml"), "name: member\n");
  write(join(mid, "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: { "acme.cap": { source: `path:${src}`, version: "1.0.0", integrity: `sha256-${"0".repeat(64)}` } } }));
  write(join(mid, "nested-a", "oas-config.yaml"), "name: a\n");
  write(join(mid, "nested-b", "oas-config.yaml"), "name: b\n");

  writeFileSync(join(base, "cp-log.txt"), "");
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws, env });
  assert.equal(r.status, 1, `integrity-drifted restore must fail:\n${r.stdout}`);
  const attempts = readFileSync(join(base, "cp-log.txt"), "utf8").split("\n").filter((l) => l.includes(src)).length;
  assert.equal(attempts, 1, `the member lock must be attempted exactly once despite nested descendants:\n${r.stdout}\ncp log:\n${readFileSync(join(base, "cp-log.txt"), "utf8")}`);
  assert.equal((r.stdout.match(/FAILED\s+acme\.cap/g) || []).length, 1, `one visible FAILED line, no hidden retries:\n${r.stdout}`);
});

test("workspace reconciliation validates config-referenced installed capabilities against visible locked packages", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  const pkg = fixturePackage(join(base, "pkg"));
  installFixturePackage(ws, pkg);
  // member config references a capability nobody supplies
  write(join(ws, "member", "oas-config.yaml"), "name: member\ncapabilities:\n  additive:\n    unsupplied.cap:\n      from: installed\n      global: true\n");
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unsupplied\.cap.*supplied by no visible locked package/);
  // a package-supplied reference passes
  write(join(ws, "member", "oas-config.yaml"), "name: member\ncapabilities:\n  additive:\n    example.review:\n      from: installed\n      global: true\n");
  const r2 = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
});

test("--recursive requests descendant reconciliation outside a team boundary and still prints the boundary first", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\n"); // no team
  write(join(ws, "member", "oas-config.yaml"), "name: member\n");
  const r = cli(["install", "--recursive", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Workspace reconciliation boundary: .*\(--recursive\)/m);
});

// ---------- host requirements ----------

test("normalizeRequirement handles legacy URL-string and structured forms", () => {
  const legacy = normalizeRequirement({ command: "tmux", why: "windows", install: "https://example.invalid/tmux" });
  assert.deepEqual(legacy, { command: "tmux", why: "windows", install: { docs: "https://example.invalid/tmux", methods: [] } });
  const structured = normalizeRequirement({ command: "x", why: "y", install: { docs: "d", methods: [{ platform: "darwin", manager: "brew", formula: "x" }] } });
  assert.equal(structured.install.methods.length, 1);
  assert.equal(normalizeRequirement({}), undefined);
});

test("requirementInstallPlan: allowlisted managers only, structured argv, no shell metacharacters, platform matching", () => {
  const req = { command: "example-cli", why: "messaging", install: { docs: "https://example.invalid", methods: [
    { platform: "darwin", manager: "npm-global", package: "@example/cli@1.2.3" },
    { platform: "linux", manager: "brew", formula: "example-cli" },
  ] } };
  const darwin = requirementInstallPlan(req, { platform: "darwin" });
  assert.deepEqual(darwin.argv, ["npm", "install", "-g", "@example/cli@1.2.3"]);
  assert.equal(darwin.version, "1.2.3");
  assert.match(darwin.scope, /user-level/);
  const linux = requirementInstallPlan(req, { platform: "linux" });
  assert.deepEqual(linux.argv, ["brew", "install", "example-cli"]);
  // no method for this platform
  const win = requirementInstallPlan(req, { platform: "win32" });
  assert.ok(win.unavailable);
  // non-allowlisted manager is ignored, never executed
  const rogue = requirementInstallPlan({ command: "x", install: { methods: [{ manager: "curl-pipe-sh", url: "https://evil" }] } }, { platform: "darwin" });
  assert.ok(rogue.unavailable);
  assert.equal(rogue.argv, undefined);
  // shell metacharacters in recipes are rejected as data, not passed anywhere
  const inj = requirementInstallPlan({ command: "x", install: { methods: [{ manager: "npm-global", package: "pkg; rm -rf /" }] } }, { platform: process.platform });
  assert.ok(inj.unavailable);
  assert.match(inj.unavailable, /not a plain package name/);
  const inj2 = requirementInstallPlan({ command: "x", install: { methods: [{ manager: "brew", formula: "a && evil" }] } }, { platform: process.platform });
  assert.match(inj2.unavailable, /not a plain formula name/);
  // download-with-checksum is stubbed as unimplemented
  const dl = requirementInstallPlan({ command: "x", install: { methods: [{ manager: "download-checksum", url: "https://x", sha256: "y" }] } }, { platform: process.platform });
  assert.match(dl.unavailable, /not implemented/);
});

test("runRequirementInstall executes argv without a shell and verifies PATH afterward", () => {
  const base = temp();
  const bin = join(base, "bin"); mkdirSync(bin);
  // fake "npm" that records argv and installs a fake binary into bin/
  write(join(bin, "npm"), `#!/bin/sh\necho "$@" > ${join(base, "npm-args.txt")}\nprintf '#!/bin/sh\\nexit 0\\n' > ${join(bin, "fresh-cli")}\nchmod +x ${join(bin, "fresh-cli")}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const plan = requirementInstallPlan({ command: "fresh-cli", install: { methods: [{ manager: "npm-global", package: "fresh-cli@2.0.0", platform: process.platform }] } });
  const r = runRequirementInstall(plan, { env, stdio: "ignore" });
  assert.equal(r.installed, true);
  assert.equal(r.onPath, true);
  assert.equal(readFileSync(join(base, "npm-args.txt"), "utf8").trim(), "install -g fresh-cli@2.0.0");
  // PATH verification fails honestly when the tool never lands
  write(join(bin, "npm"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "npm"), 0o755);
  const plan2 = requirementInstallPlan({ command: "never-lands", install: { methods: [{ manager: "npm-global", package: "never-lands", platform: process.platform }] } });
  assert.equal(runRequirementInstall(plan2, { env, stdio: "ignore" }).onPath, false);
});

test("aggregateMissingRequirements: only capabilities activated in the scopes, deduped by command, requesters reported", () => {
  const base = temp();
  const mkScope = (name, capId, active) => {
    const scope = join(base, name);
    write(join(scope, ".agents", "capabilities", "owned", capId.replace(/\./g, "-"), "oas.json"), JSON.stringify({
      capability: capId, version: "1.0.0", description: "x",
      requires: [{ command: "definitely-not-on-path-xyz", why: "testing", install: { docs: "https://example.invalid", methods: [] } }],
    }));
    write(join(scope, "oas-config.yaml"), `name: ${name}\ncapabilities:\n  additive:\n    ${capId}:\n      from: owned\n      global: ${active}\n`);
    return scope;
  };
  const s1 = mkScope("s1", "a.cap", true);
  const s2 = mkScope("s2", "b.cap", true);
  const s3 = mkScope("s3", "c.cap", false); // activated nowhere → its requirement is NOT considered
  const missing = aggregateMissingRequirements([s1, s2, s3]);
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.equal(missing[0].command, "definitely-not-on-path-xyz");
  assert.deepEqual(missing[0].requestedBy.map((r) => r.capability).sort(), ["a.cap", "b.cap"]);
});

test("noninteractive installs are fail-safe: never install by default, --accept-requirement opts in, --no-requirements skips", () => {
  const base = temp();
  const ws = join(base, "ws");
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "npm"), `#!/bin/sh\necho ran > ${join(base, "ran.txt")}\nprintf '#!/bin/sh\\nexit 0\\n' > ${join(bin, "wanted-cli")}\nchmod +x ${join(bin, "wanted-cli")}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  write(join(ws, ".agents", "capabilities", "owned", "needy", "oas.json"), JSON.stringify({
    capability: "needy.cap", version: "1.0.0", description: "x",
    requires: [{ command: "wanted-cli", why: "testing", install: { docs: "https://example.invalid", methods: [{ platform: process.platform, manager: "npm-global", package: "wanted-cli@1.0.0" }] } }],
  }));
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    needy.cap:\n      from: owned\n      global: true\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  // default noninteractive: reported, never installed, actionable skip message
  const r1 = cli(["install", "--dir", ws], { cwd: ws, env });
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /wanted-cli — testing/);
  assert.match(r1.stdout, /installer: npm install -g wanted-cli@1\.0\.0/);
  assert.match(r1.stdout, /skipped — non-interactive; pass --accept-requirement wanted-cli/);
  assert.equal(existsSync(join(base, "ran.txt")), false, "no host install without consent");

  // --no-requirements: package-only restoration, no report at all
  const r2 = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws, env });
  assert.equal(r2.status, 0, r2.stderr);
  assert.doesNotMatch(r2.stdout, /wanted-cli/);
  assert.equal(existsSync(join(base, "ran.txt")), false);

  // explicit per-requirement acceptance installs and verifies PATH
  const r3 = cli(["install", "--accept-requirement", "wanted-cli", "--dir", ws], { cwd: ws, env });
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(existsSync(join(base, "ran.txt")), true, "consented install ran");
  assert.match(r3.stdout, /installed — wanted-cli verified on PATH/);
  assert.match(r3.stdout, /consent is separate from capability trust/);
});

test("a consented requirement install that fails makes oas install exit nonzero (manager error and PATH-verify failure)", () => {
  const base = temp();
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const mkWs = (name, cmd) => {
    const ws = join(base, name);
    write(join(ws, ".agents", "capabilities", "owned", "needy", "oas.json"), JSON.stringify({
      capability: "needy.cap", version: "1.0.0", description: "x",
      requires: [{ command: cmd, why: "testing", install: { methods: [{ platform: process.platform, manager: "npm-global", package: `${cmd}@1.0.0` }] } }],
    }));
    write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    needy.cap:\n      from: owned\n      global: true\n");
    return ws;
  };
  // manager exits nonzero
  write(join(bin, "npm"), "#!/bin/sh\nexit 3\n"); chmodSync(join(bin, "npm"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const r1 = cli(["install", "--accept-requirement", "never-cli", "--dir", mkWs("ws1", "never-cli")], { env });
  assert.equal(r1.status, 1, `manager failure must exit nonzero:\n${r1.stdout}`);
  assert.match(r1.stdout, /FAILED/);
  assert.match(r1.stdout, /requirement never-cli/);
  // manager succeeds but the command never lands on PATH
  write(join(bin, "npm"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "npm"), 0o755);
  const r2 = cli(["install", "--accept-requirement", "never-cli", "--dir", mkWs("ws2", "never-cli")], { env });
  assert.equal(r2.status, 1, `PATH-verify failure must exit nonzero:\n${r2.stdout}`);
  assert.match(r2.stdout, /FAILED: install ran but never-cli is still not on PATH/);
  // unaccepted (skipped) requirements stay non-fatal
  const r3 = cli(["install", "--dir", mkWs("ws3", "never-cli")], { env });
  assert.equal(r3.status, 0, `skipped requirement must stay non-fatal:\n${r3.stdout}\n${r3.stderr}`);
  assert.match(r3.stdout, /skipped — non-interactive/);
});

test("JSON envelope integrity: noisy installers cannot contaminate stdout, and pre-report throws still emit the envelope", () => {
  const base = temp();
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // NOISY manager: prints to stdout, then installs the tool (success case)
  write(join(bin, "npm"), `#!/bin/sh\necho "PACKAGE MANAGER PROGRESS"\nprintf '#!/bin/sh\\nexit 0\\n' > "${join(bin, "noisy-cli")}"\nchmod +x "${join(bin, "noisy-cli")}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const ws = join(base, "ws");
  write(join(ws, ".agents", "capabilities", "owned", "needy", "oas.json"), JSON.stringify({
    capability: "needy.cap", version: "1.0.0", description: "x",
    requires: [{ command: "noisy-cli", why: "x", install: { methods: [{ platform: process.platform, manager: "npm-global", package: "noisy-cli" }] } }],
  }));
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    needy.cap:\n      from: owned\n      global: true\n");
  const ok = cli(["install", "--json", "--accept-requirement", "noisy-cli", "--dir", ws], { cwd: ws, env });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const env1 = JSON.parse(ok.stdout); // throws if the manager's stdout reached ours
  assert.equal(env1.result.requirements[0].outcome, "installed");
  // NOISY FAILING manager
  write(join(bin, "npm"), "#!/bin/sh\necho NOISE-BEFORE-FAILURE\nexit 3\n"); chmodSync(join(bin, "npm"), 0o755);
  const ws2 = join(base, "ws2");
  write(join(ws2, ".agents", "capabilities", "owned", "needy", "oas.json"), JSON.stringify({
    capability: "needy.cap", version: "1.0.0", description: "x",
    requires: [{ command: "never-cli", why: "x", install: { methods: [{ platform: process.platform, manager: "npm-global", package: "never-cli" }] } }],
  }));
  write(join(ws2, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    needy.cap:\n      from: owned\n      global: true\n");
  const bad = cli(["install", "--json", "--accept-requirement", "never-cli", "--dir", ws2], { cwd: ws2, env });
  assert.equal(bad.status, 1);
  const env2 = JSON.parse(bad.stdout); // single parseable envelope despite manager noise
  assert.equal(env2.error.code, "E_RECONCILE_FAILED");
  // pre-report throw: malformed oas-lock.json still yields ONE envelope, not a stack trace
  const ws3 = join(base, "ws3");
  write(join(ws3, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  write(join(ws3, "oas-lock.json"), "{not json");
  const broken = cli(["install", "--json", "--no-requirements", "--dir", ws3], { cwd: ws3 });
  assert.equal(broken.status, 1);
  const env3 = JSON.parse(broken.stdout);
  assert.equal(env3.ok, false);
  assert.ok(env3.error.code, "stable code on pre-report failures");
  // non-team chain path with a malformed lock too
  const ws4 = join(base, "ws4");
  write(join(ws4, "oas-config.yaml"), "name: ws\n");
  write(join(ws4, "oas-lock.json"), "[]");
  const broken2 = cli(["install", "--json", "--dir", ws4], { cwd: ws4 });
  if (broken2.status !== 0) {
    assert.equal(JSON.parse(broken2.stdout).ok, false, "chain path keeps the envelope on malformed locks");
  }
});

// ---------- doctor ----------

test("doctor reports profile provenance, available-but-unapplied profiles, and missing host commands", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);
  assert.equal(cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]).status, 0);
  // Provide the referenced capabilities so config resolution succeeds.
  for (const [folder, id, layer] of [["example-review", "example.review", undefined], ["example-delivery", "example.delivery", "knowledge"]]) {
    write(join(ws, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({
      capability: id, version: "1.0.0", description: "x", ...(layer ? { layer } : {}),
      ...(id === "example.review" ? { requires: [{ command: "review-helper-not-here", why: "reviews", install: { docs: "https://example.invalid/docs", methods: [{ platform: process.platform, manager: "brew", formula: "review-helper-not-here" }] } }] } : {}),
    }));
  }
  const file = join(ws, "oas-config.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("from: installed", "from: owned"));
  // activate example.review globally so its requirement is considered
  assert.equal(cli(["use", "example.review", "--global", "--dir", ws]).status, 0);
  const r = cli(["doctor", ws], { cwd: ws });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Config profile provenance: .*adopted example\.engineering.*profile "default"/);
  assert.match(r.stdout, /Missing host commands/);
  assert.match(r.stdout, /review-helper-not-here — reviews \(requested by: example\.review\)/);
  assert.match(r.stdout, /install with consent: oas install --accept-requirement review-helper-not-here/);

  // available-but-unapplied profile: a second locked+installed package with profiles, adopted nowhere
  const other = fixturePackage(join(base, "other"), { id: "other.pkg" });
  installFixturePackage(ws, other, { id: "other.pkg" });
  const r2 = cli(["doctor", ws], { cwd: ws });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /Distribution packages:/);
  assert.match(r2.stdout, /other\.pkg {2}1\.0\.0/);
  assert.match(r2.stdout, /package other\.pkg exports config profiles \(default, minimal\) not applied at any scope/);
});

test("doctor --json carries schemaVersion 1 and the WS2 payload with field parity to the human report", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);
  assert.equal(cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]).status, 0);
  for (const [folder, id, layer] of [["example-review", "example.review", undefined], ["example-delivery", "example.delivery", "knowledge"]]) {
    write(join(ws, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({
      capability: id, version: "1.0.0", description: "x", ...(layer ? { layer } : {}),
      ...(id === "example.review" ? { requires: [{ command: "json-doctor-missing-cmd", why: "testing", install: { docs: "https://example.invalid", methods: [{ platform: process.platform, manager: "brew", formula: "json-doctor-missing-cmd" }] } }] } : {}),
    }));
  }
  const file = join(ws, "oas-config.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("from: installed", "from: owned"));
  assert.equal(cli(["use", "example.review", "--global", "--dir", ws]).status, 0);
  const other = fixturePackage(join(base, "other"), { id: "other.pkg" });
  installFixturePackage(ws, other, { id: "other.pkg" });

  const r = cli(["doctor", ws, "--json"], { cwd: ws });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout); // exactly one JSON document on stdout
  assert.equal(doc.schemaVersion, 1);
  // packages: lock v2 entries with provenance (init --package locked example.engineering per Gate 1)
  assert.deepEqual(doc.packages.map((p) => p.id).sort(), ["example.engineering", "other.pkg"]);
  assert.ok(doc.packages.every((p) => p.version === "1.0.0"));
  assert.deepEqual(doc.packages.find((p) => p.id === "other.pkg").capabilities, ["example.review", "example.delivery"]);
  // profileProvenance: the adopted snapshot
  assert.equal(doc.profileProvenance.length, 1);
  assert.equal(doc.profileProvenance[0].package, "example.engineering");
  assert.equal(doc.profileProvenance[0].profile, "default");
  // unappliedProfiles: other.pkg exports profiles, adopted nowhere
  assert.deepEqual(doc.unappliedProfiles, [{ package: "other.pkg", profiles: ["default", "minimal"] }]);
  // missingHostRequirements: structured plan + consent command, no shell text
  const req = doc.missingHostRequirements.find((x) => x.command === "json-doctor-missing-cmd");
  assert.ok(req, JSON.stringify(doc.missingHostRequirements));
  assert.deepEqual(req.plan.argv, ["brew", "install", "json-doctor-missing-cmd"]);
  assert.equal(req.consentCommand, `oas install --accept-requirement json-doctor-missing-cmd --dir ${ws}`);
  assert.deepEqual(req.requestedBy.map((x) => x.capability), ["example.review"]);
  // field parity: every WS2 fact in the human report is present in JSON
  const human = cli(["doctor", ws], { cwd: ws });
  assert.match(human.stdout, /other\.pkg/);
  assert.match(human.stdout, /profile "default"/);
  assert.match(human.stdout, /json-doctor-missing-cmd/);
  assert.match(human.stdout, /oas install --accept-requirement json-doctor-missing-cmd --dir /);
});

test("malformed requirement commands reach the fail-closed policy: empty and non-string commands, canonical sort", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, ".agents", "capabilities", "owned", "broken", "oas.json"), JSON.stringify({
    capability: "broken.cap", version: "1.0.0", description: "x",
    requires: [
      { command: "", why: "empty" },
      { command: 42, why: "number" },
      { command: { x: 1 }, why: "object" },
    ],
  }));
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    broken.cap:\n      from: owned\n      global: true\n");
  // aggregation flags all three as invalid without throwing (canonical sort keys)
  const missing = aggregateMissingRequirements([ws]);
  assert.equal(missing.length, 3, JSON.stringify(missing));
  assert.ok(missing.every((m) => m.invalid && m.plan === null), "all malformed commands are typed invalid records");
  // CLI JSON: envelope with E_RECONCILE_FAILED + E_REQUIREMENT_POLICY entries, no stack trace
  const r = cli(["install", "--json", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1);
  const env = JSON.parse(r.stdout);
  assert.equal(env.error.code, "E_RECONCILE_FAILED");
  assert.equal(env.error.details.requirements.filter((q) => q.code === "E_REQUIREMENT_POLICY").length, 3);
});

test("conflict provenance covers three-plus requesters", () => {
  const base = temp();
  const ws = join(base, "ws");
  const cap3 = (id, folder, pkg) => write(join(ws, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({
    capability: id, version: "1.0.0", description: "x",
    requires: [{ command: "shared-cli", why: "x", install: { methods: [{ platform: process.platform, manager: "npm-global", package: pkg }] } }],
  }));
  cap3("a.cap", "a", "shared-cli@1.0.0");
  cap3("b.cap", "b", "shared-cli@2.0.0");
  cap3("c.cap", "c", "shared-cli@3.0.0");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    a.cap:\n      from: owned\n      global: true\n    b.cap:\n      from: owned\n      global: true\n    c.cap:\n      from: owned\n      global: true\n");
  const missing = aggregateMissingRequirements([ws]);
  assert.equal(missing.length, 1);
  assert.ok(missing[0].conflict);
  assert.deepEqual(missing[0].conflict.plans.map((p) => p.capability).sort(), ["a.cap", "b.cap", "c.cap"], "ALL requesters appear in the conflict provenance");
  assert.ok(missing[0].conflict.plans.every((p) => p.argv), "each conflicting plan carries its argv");
});

test("usage validation precedes reconciliation side effects: malformed --accept-requirement never restores", () => {
  const base = temp();
  const src = join(base, "src");
  write(join(src, "oas.json"), JSON.stringify({ capability: "acme.cap", version: "1.0.0", description: "x", compatibility: { oas: ">=0.6.2" } }));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // restorable lock — pre-fix, the restore ran BEFORE flagAll rejected usage
  const scratch = join(base, "scratch");
  write(join(scratch, "oas-config.yaml"), "name: scratch\n");
  assert.equal(cli(["install", src, "--dir", scratch]).status, 0);
  const integrity = JSON.parse(readFileSync(join(scratch, "oas-lock.json"), "utf8")).capabilities["acme.cap"].integrity;
  write(join(ws, "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: { "acme.cap": { source: `path:${src}`, version: "1.0.0", integrity } } }));
  const r = cli(["install", "--json", "--accept-requirement", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).error.code, "E_USAGE");
  assert.equal(existsSync(join(ws, ".agents", "capabilities", "installed", "src", "oas.json")), false, "usage errors must not mutate the deployment");
});

test("requirement identity fails closed: unsafe command tokens are never consentable and fail reconciliation", () => {
  const base = temp();
  const mkWs = (name, cmd) => {
    const ws = join(base, name);
    write(join(ws, ".agents", "capabilities", "owned", "needy", "oas.json"), JSON.stringify({
      capability: "needy.cap", version: "1.0.0", description: "x",
      requires: [{ command: cmd, why: "testing", install: { methods: [{ platform: process.platform, manager: "brew", formula: "whatever" }] } }],
    }));
    write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    needy.cap:\n      from: owned\n      global: true\n");
    return ws;
  };
  for (const evil of ["rm -rf /", "../sneaky", "-rf", "a;b", "$(x)", "a/b"]) {
    const missing = aggregateMissingRequirements([mkWs(`w${Buffer.from(evil).toString("hex")}`, evil)]);
    assert.equal(missing.length, 1, evil);
    assert.ok(missing[0].invalid, `unsafe token must be flagged: ${evil}`);
    assert.equal(missing[0].plan, null, `no plan for unsafe token: ${evil}`);
  }
  // CLI: invalid requirement fails reconciliation with the policy code, EVEN with --accept-requirement and --no-requirements
  const ws = mkWs("wcli", "evil;rm");
  const r = cli(["install", "--json", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1, r.stdout);
  const env = JSON.parse(r.stdout);
  assert.equal(env.error.code, "E_RECONCILE_FAILED");
  const q = env.error.details.requirements.find((x) => x.command === "evil;rm");
  assert.equal(q.outcome, "failed");
  assert.equal(q.code, "E_REQUIREMENT_POLICY");
  assert.equal(q.plan, null);
});

test("same-command conflicting plans: deterministic provenance-rich conflict, no consent; identical plans merge requestedBy", () => {
  const base = temp();
  const ws = join(base, "ws");
  const req = (pkg) => ({ command: "shared-cli", why: "x", install: { methods: [{ platform: process.platform, manager: "npm-global", package: pkg }] } });
  const cap = (id, folder, pkg) => write(join(ws, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({ capability: id, version: "1.0.0", description: "x", requires: [req(pkg)] }));
  cap("a.cap", "a", "shared-cli@1.0.0");
  cap("b.cap", "b", "shared-cli@2.0.0"); // NON-identical plan
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    a.cap:\n      from: owned\n      global: true\n    b.cap:\n      from: owned\n      global: true\n");
  const missing = aggregateMissingRequirements([ws]);
  assert.equal(missing.length, 1);
  assert.ok(missing[0].conflict, "non-identical plans must conflict");
  assert.equal(missing[0].plan, null, "no installable plan under conflict");
  assert.deepEqual(missing[0].conflict.plans.map((p) => p.capability).sort(), ["a.cap", "b.cap"]);
  assert.ok(missing[0].conflict.plans.every((p) => p.argv), "conflict carries each plan's argv provenance");
  // consent cannot force through a conflict
  const r = cli(["install", "--json", "--accept-requirement", "shared-cli", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1);
  const env = JSON.parse(r.stdout);
  assert.equal(env.error.code, "E_RECONCILE_FAILED");
  const q = env.error.details.requirements.find((x) => x.command === "shared-cli");
  assert.equal(q.code, "E_REQUIREMENT_POLICY");
  assert.equal(q.outcome, "failed");
  assert.ok(q.conflict.plans.length === 2);
  // identical plans: merged requestedBy, single consentable entry
  const ws2 = join(base, "ws2");
  for (const [id, folder] of [["a.cap", "a"], ["b.cap", "b"]]) {
    write(join(ws2, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({ capability: id, version: "1.0.0", description: "x", requires: [req("shared-cli@1.0.0")] }));
  }
  write(join(ws2, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    a.cap:\n      from: owned\n      global: true\n    b.cap:\n      from: owned\n      global: true\n");
  const merged = aggregateMissingRequirements([ws2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].conflict, undefined);
  assert.ok(merged[0].plan);
  assert.deepEqual(merged[0].requestedBy.map((x) => x.capability).sort(), ["a.cap", "b.cap"]);
});

test("--accept-requirement without a value emits the single E_USAGE envelope in JSON mode", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, ".agents", "capabilities", "owned", "needy", "oas.json"), JSON.stringify({
    capability: "needy.cap", version: "1.0.0", description: "x",
    requires: [{ command: "wanted-cli", why: "x", install: { methods: [{ platform: process.platform, manager: "npm-global", package: "wanted-cli" }] } }],
  }));
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    needy.cap:\n      from: owned\n      global: true\n");
  // valueless at end of argv
  const r1 = cli(["install", "--json", "--dir", ws, "--accept-requirement"], { cwd: ws });
  assert.equal(r1.status, 1);
  const e1 = JSON.parse(r1.stdout); // single envelope, no die() prose on stdout
  assert.equal(e1.ok, false);
  assert.equal(e1.error.code, "E_USAGE");
  // valueless because the next token is a flag
  const r2 = cli(["install", "--json", "--accept-requirement", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stdout).error.code, "E_USAGE");
  // human mode keeps die() on stderr
  const r3 = cli(["install", "--accept-requirement", "--dir", ws], { cwd: ws });
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /--accept-requirement needs a value/);
});

test("install --json: full success emits ONE compact ok envelope; failures emit E_RECONCILE_FAILED with the complete report in error.details", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  installFixturePackage(ws, pkg);
  // success path
  const ok = cli(["install", "--no-requirements", "--json", "--dir", ws], { cwd: ws });
  assert.equal(ok.status, 0, ok.stderr);
  const okEnv = JSON.parse(ok.stdout); // throws on stdout contamination
  assert.equal(okEnv.schemaVersion, 1);
  assert.equal(okEnv.ok, true);
  assert.equal(okEnv.result.boundaryKind, "team");
  assert.equal(okEnv.result.boundary, ws);
  const artifacts = okEnv.result.scopes.flatMap((s) => s.artifacts);
  assert.ok(artifacts.some((a) => a.id === "example.engineering" && a.kind === "package" && a.status === "present"), JSON.stringify(artifacts));
  assert.deepEqual(okEnv.result.failures, []);
  // failure path: descendant scope with an unrestorable lock — partial outcomes preserved in error.details
  write(join(ws, "member", "oas-config.yaml"), "name: member\n");
  write(join(ws, "member", "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: { "ghost.cap": { source: "path:/nonexistent-src", version: "1.0.0", integrity: `sha256-${"0".repeat(64)}` } } }));
  const bad = cli(["install", "--no-requirements", "--json", "--dir", ws], { cwd: ws });
  assert.equal(bad.status, 1);
  const badEnv = JSON.parse(bad.stdout);
  assert.equal(badEnv.ok, false);
  assert.equal(badEnv.error.code, "E_RECONCILE_FAILED");
  const details = badEnv.error.details;
  assert.equal(details.boundaryKind, "team");
  const all = details.scopes.flatMap((s) => s.artifacts);
  assert.ok(all.some((a) => a.id === "example.engineering" && a.status === "present"), "partial success preserved in details");
  assert.ok(all.some((a) => a.id === "ghost.cap" && a.status === "failed"), JSON.stringify(all));
  assert.ok(details.failures.some((f) => f.id === "ghost.cap"));
  // non-team chain path also honors --json (boundaryKind "chain")
  const ws2 = join(base, "ws2");
  write(join(ws2, "oas-config.yaml"), "name: ws2\n");
  const chain = cli(["install", "--no-requirements", "--json", "--dir", ws2], { cwd: ws2 });
  assert.equal(chain.status, 0, chain.stderr);
  const chainEnv = JSON.parse(chain.stdout);
  assert.equal(chainEnv.result.boundaryKind, "chain");
});

test("install --json requirements: all four consent outcomes with structured plans, no TTY prompt in JSON mode", () => {
  const base = temp();
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "npm"), `#!/bin/sh\nprintf '#!/bin/sh\\nexit 0\\n' > "${join(bin, "wanted-cli")}"\nchmod +x "${join(bin, "wanted-cli")}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const mkWs = (name, cmd) => {
    const ws = join(base, name);
    write(join(ws, ".agents", "capabilities", "owned", "needy", "oas.json"), JSON.stringify({
      capability: "needy.cap", version: "1.0.0", description: "x",
      requires: [{ command: cmd, why: "testing", install: { docs: "https://example.invalid", methods: [{ platform: process.platform, manager: "npm-global", package: `${cmd}@1.0.0` }] } }],
    }));
    write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    needy.cap:\n      from: owned\n      global: true\n");
    return ws;
  };
  // consent-required: not accepted → ok envelope, outcome enum, structured plan equal to the human plan data
  const w1 = mkWs("w1", "wanted-cli");
  const r1 = cli(["install", "--json", "--dir", w1], { cwd: w1, env });
  assert.equal(r1.status, 0, r1.stderr);
  const e1 = JSON.parse(r1.stdout);
  assert.equal(e1.ok, true);
  assert.equal(e1.result.requirements.length, 1);
  const q1 = e1.result.requirements[0];
  assert.equal(q1.outcome, "consent-required");
  assert.deepEqual(q1.plan, { manager: "npm-global", argv: ["npm", "install", "-g", "wanted-cli@1.0.0"], source: "npm registry (wanted-cli@1.0.0)", version: "1.0.0", scope: "user-level (npm global prefix)" });
  assert.deepEqual(q1.requestedBy.map((x) => x.capability), ["needy.cap"]);
  // skipped: --no-requirements
  const r2 = cli(["install", "--json", "--no-requirements", "--dir", w1], { cwd: w1, env });
  const e2 = JSON.parse(r2.stdout);
  assert.equal(e2.result.requirements[0].outcome, "skipped");
  // installed: accepted, lands on PATH, onPath true
  const r3 = cli(["install", "--json", "--accept-requirement", "wanted-cli", "--dir", w1], { cwd: w1, env });
  assert.equal(r3.status, 0, r3.stdout);
  const e3 = JSON.parse(r3.stdout);
  assert.equal(e3.result.requirements[0].outcome, "installed");
  assert.equal(e3.result.requirements[0].onPath, true);
  // failed: accepted but the manager never delivers → E_RECONCILE_FAILED with the requirement in details
  write(join(bin, "npm"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "npm"), 0o755);
  const w2 = mkWs("w2", "never-cli");
  const r4 = cli(["install", "--json", "--accept-requirement", "never-cli", "--dir", w2], { cwd: w2, env });
  assert.equal(r4.status, 1);
  const e4 = JSON.parse(r4.stdout);
  assert.equal(e4.error.code, "E_RECONCILE_FAILED");
  const q4 = e4.error.details.requirements.find((q) => q.command === "never-cli");
  assert.equal(q4.outcome, "failed");
  assert.equal(q4.onPath, false);
});

test("init --package --json: one envelope with lockFile/lockedPackages, stable error codes, no prompts", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  // adopt by locked package id so lockFile/lockedPackages are populated
  const ws = join(base, "ws");
  mkdirSync(ws, { recursive: true });
  installFixturePackage(ws, pkg);
  const r = cli(["init", "--package", pkg, "--json", "--dir", ws]);
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout); // exactly one compact document
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.ok, true);
  assert.equal(env.result.package, "example.engineering");
  assert.equal(env.result.profile, "default");
  assert.equal(env.result.file, join(ws, "oas-config.yaml"));
  assert.deepEqual(env.result.capabilities, ["example.review", "example.delivery"]);
  assert.equal(env.result.lockFile, join(ws, "oas-lock.json"));
  assert.deepEqual(env.result.lockedPackages, ["example.engineering"]);
  assert.ok(existsSync(join(ws, "oas-config.yaml")));

  // E_CONFIG_EXISTS on overwrite
  const r2 = cli(["init", "--package", pkg, "--json", "--dir", ws]);
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stdout).error.code, "E_CONFIG_EXISTS");

  // E_PROFILE_AMBIGUOUS: multiple unmarked profiles, no --config
  const multi = fixturePackage(join(base, "multi"), { id: "multi.pkg", configs: {
    a: { path: "configs/default/oas-config.yaml" }, b: { path: "configs/minimal/oas-config.yaml" },
  } });
  const w2 = join(base, "w2"); mkdirSync(w2);
  const r3 = cli(["init", "--package", multi, "--json", "--dir", w2]);
  assert.equal(JSON.parse(r3.stdout).error.code, "E_PROFILE_AMBIGUOUS");
  // E_PROFILE_NOT_FOUND: explicit unknown profile
  const r4 = cli(["init", "--package", multi, "--config", "nope", "--json", "--dir", w2]);
  assert.equal(JSON.parse(r4.stdout).error.code, "E_PROFILE_NOT_FOUND");
  // E_PROFILE_INVALID: unsupplied capability
  const bad = fixturePackage(join(base, "bad"), { id: "bad.pkg", extraFiles: {
    "configs/x/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    ghost.cap:\n      from: installed\n      global: true\n",
  }, configs: { x: { path: "configs/x/oas-config.yaml", default: true } } });
  const r5 = cli(["init", "--package", bad, "--json", "--dir", w2]);
  assert.equal(JSON.parse(r5.stdout).error.code, "E_PROFILE_INVALID");
  // engine code pass-through: broken manifest → invalid-package-manifest verbatim
  const broken = join(base, "broken");
  write(join(broken, "oas-package.json"), "null");
  const r6 = cli(["init", "--package", broken, "--json", "--dir", w2]);
  assert.equal(JSON.parse(r6.stdout).error.code, "invalid-package-manifest");
  assert.equal(existsSync(join(w2, "oas-config.yaml")), false, "no failure path may write a config");
});

test("config diff --json: envelope with diff array; zero differences exits 0 with differingLines 0; provenance defaults", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "workspace"); // matches the profile's `name: workspace` — zero-diff baseline
  mkdirSync(ws, { recursive: true });
  installFixturePackage(ws, pkg);
  assert.equal(cli(["init", "--package", "example.engineering", "--dir", ws, "--no-tmux-mouse"]).status, 0);
  // provenance-derived defaults: NO --package/--config flags, resolved via the locked id
  const same = cli(["config", "diff", "--json", "--dir", ws], { cwd: ws });
  assert.equal(same.status, 0, same.stdout);
  const e1 = JSON.parse(same.stdout);
  assert.equal(e1.ok, true);
  assert.equal(e1.result.differingLines, 0);
  assert.equal(e1.result.package, "example.engineering");
  assert.equal(e1.result.profile, "default");
  // drift shows in the diff array; the file is untouched
  const file = join(ws, "oas-config.yaml");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before + "  # local note\n");
  const drift = cli(["config", "diff", "--json", "--dir", ws], { cwd: ws });
  assert.equal(drift.status, 0);
  const e2 = JSON.parse(drift.stdout);
  assert.equal(e2.result.differingLines, 1);
  assert.deepEqual(e2.result.diff.filter((d) => d.kind !== "same"), [{ kind: "local", line: "  # local note" }]);
  assert.equal(readFileSync(file, "utf8"), before + "  # local note\n", "diff must not write");
  // error code: no config at scope
  const r3 = cli(["config", "diff", "--json", "--dir", join(base, "empty")]);
  assert.equal(JSON.parse(r3.stdout).error.code, "E_NO_CONFIG");
  // valueless --config is usage error, not silent default selection
  const r4 = cli(["config", "diff", "--config", "--json", "--dir", ws], { cwd: ws });
  assert.equal(r4.status, 1);
  assert.equal(JSON.parse(r4.stdout).error.code, "E_USAGE");
  // zero-profile package reports E_NO_PROFILES, not ambiguity
  const bare = fixturePackage(join(base, "bare"), { id: "bare.pkg", configs: {} });
  const r5 = cli(["config", "diff", "--package", bare, "--json", "--dir", ws], { cwd: ws });
  assert.equal(JSON.parse(r5.stdout).error.code, "E_NO_PROFILES");
});

test("init --package on a configless scope sees same-lock dependency capabilities in the closure", () => {
  const base = temp();
  // root package whose profile references a capability supplied ONLY by a dependency
  const root = fixturePackage(join(base, "root"), {
    id: "root.pkg",
    capabilities: { "capabilities/root-cap": { capability: "root.cap", version: "1.0.0", description: "x" } },
    dependencies: ["dep.pkg"],
    extraFiles: { "configs/d/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    dep.cap:\n      from: installed\n      global: true\n" },
    configs: { d: { path: "configs/d/oas-config.yaml", default: true } },
  });
  const dep = fixturePackage(join(base, "dep"), {
    id: "dep.pkg",
    capabilities: { "capabilities/dep-cap": { capability: "dep.cap", version: "1.0.0", description: "x" } },
    configs: {},
  });
  // configless scope: ONLY an oas-lock.json carrying root + dependency
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  installFixturePackage(ws, root, { id: "root.pkg", capabilities: ["root.cap"], dependencies: ["dep.pkg"] });
  installFixturePackage(ws, dep, { id: "dep.pkg", capabilities: ["dep.cap"] });
  const r = cli(["init", "--package", "root.pkg", "--json", "--dir", ws]);
  assert.equal(r.status, 0, r.stdout);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.result.package, "root.pkg");
  assert.deepEqual(env.result.lockedPackages.sort(), ["dep.pkg", "root.pkg"]);
});

test("restore containment: hostile lock package ids never escape the store and cleanup removes only staging", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // Sentinel artifact that a store-wide rmSync would delete.
  const sentinel = join(ws, ".agents", "packages", "installed", "innocent-pkg", "oas-package.json");
  write(sentinel, JSON.stringify({ package: "innocent-pkg", version: "1.0.0", description: "x" }));
  // Hostile lock: package id "." with an invalid path source — pre-fix, the
  // failure cleanup rmSync'd the derived destination = the whole installed root.
  write(join(ws, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: {
    ".": { source: "path:/nonexistent", version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`, capabilities: [], trustedCapabilities: [] },
    "..": { source: "path:/nonexistent", version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`, capabilities: [], trustedCapabilities: [] },
  } }, null, 2));
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /invalid package id in lock/);
  assert.ok(existsSync(sentinel), "the installed store must survive hostile lock keys");
  // no staging leftovers
  const entries = readdirSync(join(ws, ".agents", "packages", "installed"));
  assert.deepEqual(entries.filter((e) => e.includes("staging")), []);
});

test("acquisition truthfulness: path locks record commit local; stale installed content refuses to lock; config only after successful acquire", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  // (a) commit is "local" for path sources even when the source IS a git checkout
  gitRepo(pkg);
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  const r = cli(["init", "--package", pkg, "--json", "--dir", ws]);
  assert.equal(r.status, 0, r.stdout);
  const lock = JSON.parse(readFileSync(join(ws, "oas-lock.json"), "utf8"));
  assert.equal(lock.packages["example.engineering"].commit, "local", "path sources lock commit 'local' per the frozen schema");
  // (b) failed acquisition leaves NO config snapshot behind
  const badRoot = fixturePackage(join(base, "bad"), { id: "bad.pkg", dependencies: ["./missing-dep"], configs: { d: { path: "configs/default/oas-config.yaml", default: true } } });
  const ws2 = join(base, "ws2"); mkdirSync(ws2);
  const r2 = cli(["init", "--package", badRoot, "--json", "--dir", ws2]);
  assert.equal(r2.status, 1);
  assert.equal(existsSync(join(ws2, "oas-config.yaml")), false, "failed acquire must not publish the config");
  const retry = cli(["init", "--package", pkg, "--json", "--dir", ws2]);
  assert.equal(retry.status, 0, `retry must not hit E_CONFIG_EXISTS:\n${retry.stdout}`);
  // (c) stale same-ID installed content refuses to lock against a fresh source
  const ws3 = join(base, "ws3"); mkdirSync(ws3);
  const staleDest = join(ws3, ".agents", "packages", "installed", "example.engineering");
  write(join(staleDest, "oas-package.json"), JSON.stringify({ package: "example.engineering", version: "0.0.9", description: "stale" }));
  const r3 = cli(["init", "--package", pkg, "--json", "--dir", ws3]);
  assert.equal(r3.status, 1);
  assert.equal(JSON.parse(r3.stdout).error.code, "integrity-drift");
});

// ---------- oas.dev consumer fixture (primary WS2 acceptance case) ----------

/** The oas.dev-shaped consumer package per the founder-approved requirement: a
 * NON-DEFAULT OAS-project development package shipping (a) the config profile
 * adopted at a non-Git multi-repo OAS workspace root and (b) capability
 * oas.review, with reusable packages as separate dependencies — contract-
 * fixture driven (Decision shapes only; no oas.dev special case in production
 * code). Manifest/profile dependency shapes are isolated HERE: WS3
 * coordination after the amended engine head may adjust the dependency spec
 * form (currently a local path per the phase-1 seam; will become an official
 * catalog selector) and the profile's capability set — one cheap edit. */
function oasDevFixture(base) {
  // Reusable dependency package (separate, not folded into oas.dev).
  const dep = join(base, "src", "oas-knowledge");
  write(join(dep, "capabilities", "knowledge", "oas.json"), JSON.stringify({
    capability: "oasdev.knowledge", version: "1.0.0", description: "Knowledge layer capability.", layer: "knowledge",
  }, null, 2));
  write(join(dep, "oas-package.json"), JSON.stringify({
    package: "oasdev.knowledge-pkg", version: "1.0.0", description: "Reusable knowledge dependency.",
    compatibility: { oas: ">=0.6.2" },
    capabilities: ["capabilities/knowledge"],
  }, null, 2));
  // oas.dev itself: ships oas.review + the workspace default profile.
  const root = join(base, "src", "oas-dev");
  write(join(root, "capabilities", "review", "oas.json"), JSON.stringify({
    capability: "oas.review", version: "1.0.0", description: "Post-commit review capability.",
  }, null, 2));
  write(join(root, "oas-package.json"), JSON.stringify({
    package: "oas.dev", version: "1.0.0", description: "OAS-project development package.",
    compatibility: { oas: ">=0.6.2" },
    capabilities: ["capabilities/review"],
    configs: {
      default: { path: "configs/default/oas-config.yaml", description: "OAS project workspace defaults", default: true },
    },
    // WS3-coordination point: dependency spec form (local path now; official
    // catalog selector once the amended engine head + catalog land).
    dependencies: ["../oas-knowledge"],
  }, null, 2));
  write(join(root, "configs", "default", "oas-config.yaml"), [
    "name: workspace",
    "",
    "team:",
    "  name: oas-project",
    "",
    "agent-types:",
    "  developers:",
    "    description: Agents that build the project",
    "",
    "capabilities:",
    "  layers:",
    "    knowledge:",
    "      capability: oasdev.knowledge",
    "      from: installed",
    "  additive:",
    "    oas.review:",
    "      from: installed",
    "      agent-types:",
    "        developers: true",
    "",
  ].join("\n"));
  return { root, dep };
}

test("oas.dev consumer fixture: fresh non-Git source → profile snapshot + complete lock graph + bare restore", () => {
  const base = temp();
  const { root } = oasDevFixture(base);
  const ws = join(base, "workspace"); mkdirSync(ws, { recursive: true });

  // 1. Adopt: oas init --package <fresh local source> — nothing locked or installed yet.
  const r = cli(["init", "--package", root, "--json", "--dir", ws]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.result.package, "oas.dev");
  assert.equal(env.result.profile, "default");
  // Gate 1: adoption established the COMPLETE closure lock — root + dependency.
  assert.equal(env.result.lockFile, join(ws, "oas-lock.json"), "lockFile must be non-null and at the scope");
  assert.deepEqual(env.result.lockedPackages.sort(), ["oas.dev", "oasdev.knowledge-pkg"]);
  // snapshot is an ordinary scoped config with provenance
  const snapshot = readFileSync(join(ws, "oas-config.yaml"), "utf8");
  assert.match(snapshot, /^# package: oas\.dev@\S+ profile: default \(snapshot/);
  assert.match(snapshot, /capability: oasdev\.knowledge/);
  // lock entries are schema-shaped: exact integrity, capabilities metadata, dependencies by id
  const lock = JSON.parse(readFileSync(join(ws, "oas-lock.json"), "utf8"));
  assert.equal(lock.lockfileVersion, 2);
  const rootLock = lock.packages["oas.dev"];
  assert.match(rootLock.integrity, /^sha256-[0-9a-f]{64}$/);
  assert.deepEqual(rootLock.capabilities, ["oas.review"]);
  assert.deepEqual(rootLock.dependencies, ["oasdev.knowledge-pkg"]);
  assert.deepEqual(lock.packages["oasdev.knowledge-pkg"].capabilities, ["oasdev.knowledge"]);
  // both packages materialized in the store
  assert.ok(existsSync(join(ws, ".agents", "packages", "installed", "oas.dev", "oas-package.json")));
  assert.ok(existsSync(join(ws, ".agents", "packages", "installed", "oasdev.knowledge-pkg", "oas-package.json")));

  // 2. Clean-checkout simulation: delete the store, keep config + lock, bare restore.
  rmSync(join(ws, ".agents", "packages"), { recursive: true, force: true });
  const r2 = cli(["install", "--no-requirements", "--json", "--dir", ws], { cwd: ws });
  assert.equal(r2.status, 0, r2.stdout);
  const env2 = JSON.parse(r2.stdout);
  assert.equal(env2.ok, true, JSON.stringify(env2));
  const restored = env2.result.scopes.flatMap((s) => s.artifacts).filter((a) => a.kind === "package" && a.status === "restored");
  assert.deepEqual(restored.map((a) => a.id).sort(), ["oas.dev", "oasdev.knowledge-pkg"]);
  assert.ok(existsSync(join(ws, ".agents", "packages", "installed", "oas.dev", "oas-package.json")), "restore rematerializes the store");

  // 3. Idempotence: a second bare install reports everything ok.
  const r3 = cli(["install", "--no-requirements", "--json", "--dir", ws], { cwd: ws });
  const env3 = JSON.parse(r3.stdout);
  assert.ok(env3.result.scopes.flatMap((s) => s.artifacts).every((a) => a.kind !== "package" || a.status === "present"), JSON.stringify(env3.result.scopes));

  // 4. Adopter sovereignty survives: config diff via provenance defaults, read-only.
  const r4 = cli(["config", "diff", "--json", "--dir", ws], { cwd: ws });
  assert.equal(r4.status, 0, r4.stdout);
  assert.equal(JSON.parse(r4.stdout).result.differingLines, 0);
});

test("oas.dev end-to-end at a NON-GIT multi-repo team root: overrides, portability, snapshot semantics, nested reconciliation (targeting PROVISIONAL pending engine capability indexing)", () => {
  const base = temp();
  const { root } = oasDevFixture(base);
  // Non-Git multi-repo workspace root — first-class: NO .git anywhere at the boundary.
  const ws = join(base, "oas-project"); mkdirSync(ws, { recursive: true });

  // (1) Adoption with an explicit --config at the non-git root.
  const r = cli(["init", "--package", root, "--config", "default", "--json", "--dir", ws]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(ws, ".git")), false, "the boundary must not need git");
  const snapshot = readFileSync(join(ws, "oas-config.yaml"), "utf8");
  assert.match(snapshot, /^# package: oas\.dev@\S+ profile: default \(snapshot/);

  // (5) Portability: no machine paths, credentials, or personal/provider account ids in the profile.
  const profileText = readFileSync(join(root, "configs", "default", "oas-config.yaml"), "utf8");
  for (const text of [profileText, snapshot.replace(/^# package: .*\n/, "")]) {
    assert.doesNotMatch(text, /\/Users\/|\/home\/|[A-Z]:\\/, "no machine paths");
    assert.doesNotMatch(text, /(api[-_]?key|token|secret|password|credential)/i, "no credentials");
    assert.doesNotMatch(text, /@[a-z0-9.-]+\.[a-z]{2,}/i, "no personal/provider account ids");
  }

  // (2) Closure locked; (3) exported capability independently targetable after adoption.
  const locks = JSON.parse(readFileSync(join(ws, "oas-lock.json"), "utf8")).packages;
  assert.deepEqual(Object.keys(locks).sort(), ["oas.dev", "oasdev.knowledge-pkg"]);
  // PROVISIONAL COVERAGE (reviewer-d5dadab): acceptance point 3 is NOT fully
  // satisfied on this branch. Capability discovery THROUGH installed package
  // roots is the engine's `installed-package` origin (frozen contract §3) and
  // has not merged; the owned-store materialization below is a stand-in that
  // exercises the config-side semantics (targeting/overrides/snapshot) but
  // BYPASSES the installed-package boundary — a broken installed-package
  // integration would not fail this test. The gate-2 teardown replaces this
  // block with targeting of the capability discovered from the restored
  // package, which is when point 3 becomes real acceptance coverage.
  for (const [folder, id, layer] of [["review", "oas.review", undefined], ["knowledge", "oasdev.knowledge", "knowledge"]]) {
    write(join(ws, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({ capability: id, version: "1.0.0", description: "x", ...(layer ? { layer } : {}) }));
  }
  writeFileSync(join(ws, "oas-config.yaml"), readFileSync(join(ws, "oas-config.yaml"), "utf8").replaceAll("from: installed", "from: owned"));
  // Retarget oas.review from the profile's agent-type binding to global — ordinary `oas use`.
  const useR = cli(["use", "oas.review", "--global", "--dir", ws]);
  assert.equal(useR.status, 0, useR.stderr);
  const wsResolved = resolveOasConfig(ws, undefined);
  assert.ok(wsResolved.capabilities.some((c) => c.id === "oas.review"), "retargeted capability resolves globally");
  assert.equal(wsResolved.layers.knowledge.id, "oasdev.knowledge");

  // (4) Closer child-repo config overrides the workspace assignment.
  const child = join(ws, "member-repo"); mkdirSync(child, { recursive: true });
  write(join(child, "oas-config.yaml"), "name: member\ncapabilities:\n  layers:\n    knowledge: none\n  additive:\n    oas.review:\n      from: owned\n      global: false\n");
  const childResolved = resolveOasConfig(child, undefined);
  assert.equal(childResolved.layers.knowledge, undefined, "child disables the inherited layer");
  assert.equal(childResolved.capabilities.some((c) => c.id === "oas.review"), false, "child excludes the capability");
  assert.ok(resolveOasConfig(ws, undefined).capabilities.some((c) => c.id === "oas.review"), "workspace scope unaffected");

  // (7) Bare install at the team boundary reconciles nested repos.
  // The child repo carries its own lock for an ADDITIONAL package (multi-repo shape).
  const extra = join(base, "src", "extra");
  write(join(extra, "capabilities", "extra", "oas.json"), JSON.stringify({ capability: "oasdev.extra", version: "1.0.0", description: "x" }));
  write(join(extra, "oas-package.json"), JSON.stringify({ package: "oasdev.extra-pkg", version: "1.0.0", description: "Extra member package.", capabilities: ["capabilities/extra"] }));
  // acquire at a probe scope (engine seam) to produce a schema-true lock entry, then reuse it at the child
  const probe = join(base, "probe"); mkdirSync(probe, { recursive: true });
  acquirePackage(probe, extra);
  const childLock = { lockfileVersion: 2, packages: { "oasdev.extra-pkg": JSON.parse(readFileSync(join(probe, "oas-lock.json"), "utf8")).packages["oasdev.extra-pkg"] } };
  write(join(child, "oas-lock.json"), JSON.stringify(childLock, null, 2));
  rmSync(join(ws, ".agents", "packages"), { recursive: true, force: true });
  const rec = cli(["install", "--no-requirements", "--json", "--dir", ws], { cwd: ws });
  assert.equal(rec.status, 0, rec.stdout);
  const env = JSON.parse(rec.stdout);
  assert.equal(env.result.boundaryKind, "team", "the adopted profile's team: declares the boundary");
  const arts = env.result.scopes.flatMap((s) => s.artifacts).filter((a) => a.kind === "package");
  assert.deepEqual(arts.filter((a) => a.status === "restored").map((a) => a.id).sort(), ["oas.dev", "oasdev.extra-pkg", "oasdev.knowledge-pkg"], JSON.stringify(arts));
  assert.ok(existsSync(join(child, ".agents", "packages", "installed", "oasdev.extra-pkg", "oas-package.json")), "nested repo's own package restored at its scope");

  // (6) Snapshot, not live inheritance: mutate the SOURCE package profile; local config resolution is unchanged.
  // (After reconciliation — a drifted source must NOT restore, which is its own contract.)
  write(join(root, "configs", "default", "oas-config.yaml"), "name: workspace\nteam:\n  name: hijacked\ncapabilities:\n  layers:\n    knowledge: none\n");
  const afterMutation = resolveOasConfig(ws, undefined);
  assert.equal(afterMutation.team.name, "oas-project", "package edits never rewrite the snapshot");
  assert.equal(afterMutation.layers.knowledge.id, "oasdev.knowledge");
  // … but config diff REPORTS the drift (read-only, against the INSTALLED locked copy).
  const drift = cli(["config", "diff", "--json", "--dir", ws], { cwd: ws });
  assert.equal(drift.status, 0, drift.stdout);
  // The installed locked copy has not drifted (snapshots + locks pin exactly); local edits (from: owned + oas use) show as local drift.
  assert.ok(JSON.parse(drift.stdout).result.differingLines > 0, "diff reports local drift, read-only");
});

// ---------- provenance helpers ----------

test("profile provenance header round-trips through the parser", () => {
  const header = profileProvenanceHeader({ pkg: "acme.pkg", version: "2.0.0", profile: "default", commit: "abcdef1234567890" });
  const prov = parseProfileProvenance(header + "\nname: x\n");
  assert.deepEqual(prov, { package: "acme.pkg", ref: "abcdef123456", profile: "default" });
  assert.equal(parseProfileProvenance("name: x\n"), undefined);
});

test("commandOnPath finds executables only via PATH lookup", () => {
  assert.equal(commandOnPath("sh"), true);
  assert.equal(commandOnPath("definitely-not-a-real-cmd-xyz"), false);
  assert.equal(commandOnPath("/bin/sh"), false, "path-shaped commands are not PATH lookups");
});
