import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveOasConfig } from "../lib/core.mjs";
import {
  aggregateMissingRequirements, commandOnPath, diffConfigTexts, discoverWorkspaceScopes,
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
  const dest = join(installedPackagesDir(scope), packageSlug(id));
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync("cp", ["-R", pkgDir, dest]);
  const lockFile = join(scope, "oas-lock.json");
  const parsed = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")) : { lockfileVersion: 2, packages: {} };
  parsed.lockfileVersion = 2; parsed.packages ||= {};
  parsed.packages[id] = {
    source: `path:${pkgDir}`, version: "1.0.0", commit: "local",
    integrity: `sha256-${"0".repeat(64)}`,
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
  assert.throws(() => selectProfile(none), /exports no config profiles/);
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

  // provenance header supplies package/profile defaults
  const r2 = cli(["config", "diff", "--dir", ws]);
  assert.equal(r2.status, 1); // provenance names the package id, which is not locked/installed here
  assert.match(r2.stderr, /not a locked package id/);
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

test("reconciliation fails clearly when a v2 package lock has no installed artifact, and passes when it does", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // package lock WITHOUT the installed store: must FAIL, never exit 0 silently
  write(join(ws, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: { "example.engineering": {
    source: `path:${pkg}`, version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`,
    capabilities: ["example.review", "example.delivery"], dependencies: [], trustedCapabilities: [],
  } } }, null, 2));
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1, `missing package artifact must fail reconciliation:\n${r.stdout}`);
  assert.match(r.stdout, /FAILED\s+package example\.engineering\s+not installed/);
  assert.match(r.stdout, /Failures by scope:/);
  // with the store present, the same lock reports ok and exits 0
  installFixturePackage(ws, pkg);
  const r2 = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
  assert.match(r2.stdout, /ok\s+package example\.engineering/);
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
  assert.match(r1.stdout, /consented requirement install.*failed/);
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
