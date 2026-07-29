import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveOasConfig, capabilityIntegrity, acquirePackage, loadPackageManifestAt, parsePackageSource, readPackageLocks } from "../lib/core.mjs";
import {
  aggregateMissingRequirements, applyConfigMerge, beginRunJournal, capabilityRuntimeTargets, commandOnPath, diffConfigTexts, discoverWorkspaceScopes,
  planConfigMerge, splitConfigLines,
  lockedPackageCapabilities, normalizeRequirement, packageSpecIdentity, runtimePackageInstalled, runtimePackageStatus,
  parseProfileProvenance, profileProvenanceHeader, requirementInstallPlan,
  readProfileText, resolveProfilePackage, runRequirementInstall, selectProfile, validateProfile,
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

/** A revised-v2 lock document. Package rows carry NO capability list and no
 * trust — the capability rows' `package` back-reference is the single provider
 * truth, and a package row carrying `capabilities`/`trustedCapabilities` is the
 * forbidden transitional shape. */
function lockV2({ pkg = "example.engineering", source, path = ".", version = "1.0.0", commit = "local", integrity = `sha256-${"0".repeat(64)}`, dependencies = [], capabilities = {} } = {}) {
  const caps = {};
  for (const [id, spec] of Object.entries(capabilities)) {
    caps[id] = {
      version: spec.version || "1.0.0", package: spec.package || pkg,
      path: spec.path || `capabilities/${id.split(".").pop()}`,
      integrity: spec.integrity || `sha256-${"1".repeat(64)}`, trusted: spec.trusted ?? false,
    };
  }
  return JSON.stringify({
    lockfileVersion: 2,
    packages: { [pkg]: { source, path, version, commit, integrity, dependencies } },
    capabilities: caps,
  }, null, 2);
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

/** Install a fixture package via the ENGINE's acquirePackage (fixture writes
 * migrated per gate 2 — no direct lock/store writes). */
function installFixturePackage(scope, pkgDir) {
  mkdirSync(scope, { recursive: true });
  const r = acquirePackage(scope, pkgDir);
  return r.installed.find((p) => p.dir)?.dir;
}

/** Engine-loaded manifest of a fixture package dir. */
const loadFixtureManifest = (dir) => loadPackageManifestAt(dir);

// ---------- manifest ----------

test("profile selection: marked default, single profile, explicit name, multiple unmarked require a choice", () => {
  const base = temp();
  const m = loadFixtureManifest(fixturePackage(join(base, "pkg")));
  assert.equal(selectProfile(m).name, "default");
  assert.equal(selectProfile(m, "minimal").name, "minimal");
  assert.throws(() => selectProfile(m, "nope"), /no config profile "nope"/);

  const single = loadFixtureManifest(fixturePackage(join(base, "single"), { configs: { only: { path: "configs/default/oas-config.yaml" } } }));
  assert.equal(selectProfile(single).name, "only");

  const multi = loadFixtureManifest(fixturePackage(join(base, "multi"), { configs: {
    a: { path: "configs/default/oas-config.yaml" }, b: { path: "configs/minimal/oas-config.yaml" },
  } }));
  assert.throws(() => selectProfile(multi), /none marked default.*--config/s);

  const none = loadFixtureManifest(fixturePackage(join(base, "none"), { configs: {} }));
  assert.throws(() => selectProfile(none), (e) => e.code === "E_NO_PROFILES" && /exports no config profiles/.test(e.message));
  // typed codes on the other selection failures
  assert.throws(() => selectProfile(multi), (e) => e.code === "E_PROFILE_AMBIGUOUS");
  assert.throws(() => selectProfile(m, "nope"), (e) => e.code === "E_PROFILE_NOT_FOUND");
});

// ---------- profile validation ----------

test("profile validation: schema, dependency closure, layer agreement, agent types, path escapes", () => {
  const base = temp();
  const m = loadFixtureManifest(fixturePackage(join(base, "pkg")));
  assert.deepEqual(validateProfile(m, selectProfile(m)), []);

  // capability not supplied by package or dependency closure
  const orphan = loadFixtureManifest(fixturePackage(join(base, "orphan"), { extraFiles: {
    "configs/orphan/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    ghost.cap:\n      from: installed\n      global: true\n",
  }, configs: { orphan: { path: "configs/orphan/oas-config.yaml", default: true } } }));
  const errs1 = validateProfile(orphan, selectProfile(orphan));
  assert.ok(errs1.some((e) => /ghost\.cap is not supplied/.test(e)), errs1.join("; "));
  // ... but a dependency-supplied capability (with its provider manifest) passes
  assert.deepEqual(validateProfile(orphan, selectProfile(orphan), { dependencyProviders: new Map([["ghost.cap", { capability: "ghost.cap" }]]) }), []);
  // a dependency-supplied capability bound to a LAYER with a mismatched provider
  // manifest is rejected (reviewer-455ba15 fix 3) — and an id-only (manifest-less)
  // provider cannot silently pass layer validation either
  const depLayer = loadFixtureManifest(fixturePackage(join(base, "dep-layer"), {
    capabilities: { "capabilities/own": { capability: "own.cap", version: "1.0.0", description: "x", compatibility: { oas: ">=0.6.2" } } },
    extraFiles: { "configs/l/oas-config.yaml": "name: w\ncapabilities:\n  layers:\n    knowledge:\n      capability: dep.knowledge\n      from: installed\n" },
    configs: { l: { path: "configs/l/oas-config.yaml", default: true } },
  }));
  const wrongDep = validateProfile(depLayer, selectProfile(depLayer), { dependencyProviders: new Map([["dep.knowledge", { capability: "dep.knowledge", layer: "messaging" }]]) });
  assert.ok(wrongDep.some((e) => /layer knowledge binds dep\.knowledge, but its manifest declares layer "messaging"/.test(e)), wrongDep.join("; "));
  const manifestless = validateProfile(depLayer, selectProfile(depLayer), { dependencyProviders: new Map([["dep.knowledge", null]]) });
  assert.ok(manifestless.some((e) => /provider manifest is not available to verify the layer/.test(e)), manifestless.join("; "));
  const rightDep = validateProfile(depLayer, selectProfile(depLayer), { dependencyProviders: new Map([["dep.knowledge", { capability: "dep.knowledge", layer: "knowledge" }]]) });
  assert.deepEqual(rightDep, []);

  // layer disagreement with the capability manifest
  const wrongLayer = loadFixtureManifest(fixturePackage(join(base, "wrong-layer"), { extraFiles: {
    "configs/w/oas-config.yaml": "name: w\ncapabilities:\n  layers:\n    messaging:\n      capability: example.delivery\n      from: installed\n",
  }, configs: { w: { path: "configs/w/oas-config.yaml", default: true } } }));
  const errs2 = validateProfile(wrongLayer, selectProfile(wrongLayer));
  assert.ok(errs2.some((e) => /layer messaging binds example\.delivery, but its manifest declares layer "knowledge"/.test(e)), errs2.join("; "));

  // syntactically invalid agent type
  const badType = loadFixtureManifest(fixturePackage(join(base, "bad-type"), { extraFiles: {
    "configs/t/oas-config.yaml": "name: w\nagent-types:\n  Bad_Type:\n    description: nope\n",
  }, configs: { t: { path: "configs/t/oas-config.yaml", default: true } } }));
  assert.ok(validateProfile(badType, selectProfile(badType)).some((e) => /agent type "Bad_Type"/.test(e)));

  // schema-invalid profile (unknown top-level key)
  const badSchema = loadFixtureManifest(fixturePackage(join(base, "bad-schema"), { extraFiles: {
    "configs/s/oas-config.yaml": "name: w\ntotally-unknown-key: 1\n",
  }, configs: { s: { path: "configs/s/oas-config.yaml", default: true } } }));
  assert.ok(validateProfile(badSchema, selectProfile(badSchema)).some((e) => /unsupported oas-config key/.test(e)));

  // paths escaping the target scope
  const escape = loadFixtureManifest(fixturePackage(join(base, "escape"), { extraFiles: {
    "configs/e/oas-config.yaml": "name: w\ncapabilities:\n  layers:\n    knowledge:\n      capability: example.delivery\n      from: installed\n      injection-override: ../../outside.md\nwork-modes:\n  worktree:\n    setup: /usr/bin/evil\n",
  }, configs: { e: { path: "configs/e/oas-config.yaml", default: true } } }));
  const errs3 = validateProfile(escape, selectProfile(escape));
  assert.ok(errs3.some((e) => /injection-override escapes the target scope/.test(e)), errs3.join("; "));
  assert.ok(errs3.some((e) => /work-modes\.worktree\.setup escapes/.test(e)), errs3.join("; "));

  // profiles must not reference host paths
  const hostPath = loadFixtureManifest(fixturePackage(join(base, "host-path"), { extraFiles: {
    "configs/h/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    x.cap:\n      from: path:/abs/dir\n      global: true\n",
  }, configs: { h: { path: "configs/h/oas-config.yaml", default: true } } }));
  assert.ok(validateProfile(hostPath, selectProfile(hostPath)).some((e) => /must reference installed capabilities, not host paths/.test(e)));
});

// ---------- init --package (CLI) ----------

test("oas init --package: adopts a template verbatim with a recorded base; default and explicit choice; refusals write nothing", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);

  const r = cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Config template "default"/);
  assert.match(r.stdout, /installs 2 capability\(ies\): example\.review, example\.delivery/);

  const file = join(ws, "oas-config.yaml");
  const text = readFileSync(file, "utf8");
  const templateText = readFileSync(join(pkg, "configs/default/oas-config.yaml"), "utf8");
  // The adopted config is the template's EXACT bytes. It is not rewritten on the
  // way in — not even `name:` — because the recorded base must equal the
  // template, so that the first `oas config diff` truthfully reports no drift.
  assert.equal(text, templateText, "the adopted config must be the template byte for byte");
  const adoptedDir = join(ws, ".agents/config-templates/adopted/example.engineering/default");
  assert.equal(readFileSync(join(adoptedDir, "oas-config.yaml"), "utf8"), templateText, "the recorded base must be the same exact bytes");
  const meta = JSON.parse(readFileSync(join(adoptedDir, "adoption.json"), "utf8"));
  assert.equal(meta.package, "example.engineering");
  assert.equal(meta.template, "default");
  assert.match(meta.hash, /^sha256-[0-9a-f]{64}$/);
  // Commit-safe: a local source is recorded as such, never as a machine path.
  assert.equal(meta.source, null);
  assert.equal(meta.localSource, true);

  // refusal to overwrite an existing config
  const r2 = cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /already exists/);
  assert.equal(readFileSync(file, "utf8"), text, "an existing config must not be rewritten");

  // explicit template choice
  const ws2 = join(base, "ws2"); mkdirSync(ws2);
  const r3 = cli(["init", "--package", pkg, "--config", "minimal", "--dir", ws2, "--no-tmux-mouse"]);
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(existsSync(join(ws2, ".agents/config-templates/adopted/example.engineering/minimal/adoption.json")), true);

  // multiple unmarked templates require --config, and refuse before touching anything
  const multiPkg = fixturePackage(join(base, "multi"), { id: "multi.pkg", configs: {
    a: { path: "configs/default/oas-config.yaml" }, b: { path: "configs/minimal/oas-config.yaml" },
  } });
  const ws3 = join(base, "ws3"); mkdirSync(ws3);
  const r4 = cli(["init", "--package", multiPkg, "--dir", ws3, "--no-tmux-mouse"]);
  assert.equal(r4.status, 1);
  assert.match(r4.stderr, /--config/);
  assert.deepEqual(readdirSync(ws3), [], "an ambiguous refusal must leave the scope completely untouched");

  // an invalid template refuses, and leaves nothing behind
  const badPkg = fixturePackage(join(base, "bad"), { id: "bad.pkg", extraFiles: {
    "configs/x/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    ghost.cap:\n      from: installed\n      global: true\n",
  }, configs: { x: { path: "configs/x/oas-config.yaml", default: true } } });
  const ws4 = join(base, "ws4"); mkdirSync(ws4);
  const r5 = cli(["init", "--package", badPkg, "--dir", ws4, "--no-tmux-mouse"]);
  assert.equal(r5.status, 1);
  assert.match(r5.stderr, /failed validation/);
  assert.deepEqual(readdirSync(ws4), [], "a refused template must leave no lock, store, or anchor");

  rmSync(base, { recursive: true, force: true });
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

test("oas config diff is report-only: shows drift three ways, never writes a byte", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);
  assert.equal(cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse"]).status, 0);
  const file = join(ws, "oas-config.yaml");
  const adopted = readFileSync(file, "utf8");

  // Freshly adopted: the config, the recorded base and the template all agree,
  // so there is genuinely nothing to report. (The config is the template
  // verbatim, so this is exact rather than approximately clean.)
  const same = cli(["config", "diff", "--dir", ws]);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /report only/);
  assert.match(same.stdout, /No differences/);

  // A local edit shows as a local-only region, and diff writes nothing.
  const edited = `${adopted}\n# local note\n`;
  writeFileSync(file, edited);
  const r = cli(["config", "diff", "--dir", ws]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LOCAL ONLY/);
  assert.match(r.stdout, /# local note/);
  assert.equal(readFileSync(file, "utf8"), edited, "diff must not write");

  // The adopted base supplies the package and template — no flags needed. An
  // explicit --config names the template within the adopted package.
  const explicit = cli(["config", "diff", "--config", "default", "--dir", ws]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /example\.engineering:default/);

  // Without an adopted base there is nothing to compare against, and that is a
  // typed refusal rather than a guess at which template the config came from.
  const bare = join(base, "bare"); mkdirSync(bare);
  writeFileSync(join(bare, "oas-config.yaml"), "name: bare\n");
  const orphan = cli(["config", "diff", "--dir", bare, "--json"]);
  assert.equal(orphan.status, 1);
  assert.equal(JSON.parse(orphan.stdout).error.code, "E_NO_ADOPTED_BASE");

  rmSync(base, { recursive: true, force: true });
});

test("diffConfigTexts produces a minimal line diff", () => {
  const d = diffConfigTexts("a\nb\nc\n", "a\nx\nc\n");
  assert.deepEqual(d, [
    { kind: "same", line: "a" }, { kind: "local", line: "b" }, { kind: "package", line: "x" }, { kind: "same", line: "c" },
  ]);
});

// ---------- config template three-way merge (byte-preserving) ----------
//
// These cover the merge CORE only: three texts in, one text out. No engine
// symbol, no lock, no filesystem — the CLI transaction that feeds it the
// adopted base, the local config, and the locked template is a separate layer.

/** A hand-edited local config: comments, blank lines, a non-alphabetical key
 * order, two-space and four-space indentation mixed, and no trailing newline.
 * Every byte of this outside an explicitly selected region must survive. */
const HAND_EDITED = [
  "# our workspace — do not reformat, the ordering is deliberate",
  "team: acme",
  "",
  "capabilities:",
  "  layers:",
  "    knowledge:",
  "      capability: example.delivery   # trailing comment we care about",
  "  additive:",
  "    example.review: {}",
  "",
  "# agent types last on purpose",
  "agent-types:",
  "    dev: {}",
].join("\n");

test("splitConfigLines round-trips bytes exactly: LF, CRLF, no trailing newline, blank lines, empty", () => {
  for (const text of ["", "a\n", "a", "a\nb\n", "a\r\nb\r\n", "a\r\nb", "\n\n\n", "a\n\nb\n", HAND_EDITED]) {
    assert.equal(splitConfigLines(text).join(""), text, `round-trip failed for ${JSON.stringify(text)}`);
  }
  assert.deepEqual(splitConfigLines("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitConfigLines("a\r\nb\r\n"), ["a\r\n", "b\r\n"]);
  assert.deepEqual(splitConfigLines(""), []);
});

test("no drift: identical base/local/template yields no regions and a byte-identical apply", () => {
  const plan = planConfigMerge(HAND_EDITED, HAND_EDITED, HAND_EDITED);
  assert.deepEqual(plan.regions, []);
  assert.equal(plan.clean, true);
  assert.deepEqual(plan.counts, { upstream: 0, local: 0, conflict: 0, agreed: 0 });
  const { text, applied } = applyConfigMerge(HAND_EDITED, plan, {});
  assert.equal(text, HAND_EDITED);
  assert.deepEqual(applied, []);
});

test("conflict-free sync: an upstream-only change applies while every untouched local byte stays identical", () => {
  // Local hand-edited the team line and added a comment; the template added a
  // new additive capability somewhere else entirely. Disjoint regions.
  const base = HAND_EDITED;
  const local = HAND_EDITED.replace("team: acme", "team: acme-eu   # renamed after the split");
  const template = HAND_EDITED.replace("    example.review: {}", "    example.review: {}\n    example.audit: {}");

  const plan = planConfigMerge(base, local, template);
  assert.equal(plan.clean, true);
  assert.deepEqual(plan.counts, { upstream: 1, local: 1, conflict: 0, agreed: 0 });
  const upstream = plan.regions.find((r) => r.kind === "upstream");
  const localOnly = plan.regions.find((r) => r.kind === "local");
  assert.equal(upstream.recommended, "package");
  assert.equal(localOnly.recommended, "local");
  assert.match(upstream.template.text, /example\.audit/);

  const { text, applied } = applyConfigMerge(local, plan, {});
  // The local-only edit survived, the upstream addition landed, and nothing
  // else moved: byte-for-byte the local file plus exactly that one insertion.
  assert.equal(text, local.replace("    example.review: {}", "    example.review: {}\n    example.audit: {}"));
  assert.match(text, /team: acme-eu   # renamed after the split/);
  assert.match(text, /# our workspace — do not reformat, the ordering is deliberate/);
  assert.match(text, /      capability: example\.delivery   # trailing comment we care about/);
  assert.match(text, /^agent-types:\n    dev: \{\}$/m);
  assert.deepEqual(applied.map((a) => a.kind), ["upstream"]);
});

test("local-only drift is never offered away: keeping the recommendations returns the local bytes unchanged", () => {
  const base = HAND_EDITED;
  const local = `${HAND_EDITED}\n\n# a whole block only we have\nwork-modes:\n  worktree: {}\n`;
  const plan = planConfigMerge(base, local, base);
  assert.deepEqual(plan.counts, { upstream: 0, local: 1, conflict: 0, agreed: 0 });
  assert.equal(plan.regions[0].recommended, "local");
  assert.equal(applyConfigMerge(local, plan, {}).text, local);
});

test("both sides made the SAME change: reported as agreed, applying it is a no-op", () => {
  const base = HAND_EDITED;
  const same = HAND_EDITED.replace("team: acme", "team: acme-global");
  const plan = planConfigMerge(base, same, same);
  assert.deepEqual(plan.counts, { upstream: 0, local: 0, conflict: 0, agreed: 1 });
  assert.equal(plan.clean, true);
  const { text, applied } = applyConfigMerge(same, plan, {});
  assert.equal(text, same);
  assert.deepEqual(applied, []);
});

test("overlapping edits are an explicit conflict: no decision fails closed, local/package/edit all resolve byte-preservingly", () => {
  const base = HAND_EDITED;
  const local = HAND_EDITED.replace("team: acme", "team: acme-eu");
  const template = HAND_EDITED.replace("team: acme", "team: acme-global");

  const plan = planConfigMerge(base, local, template);
  assert.deepEqual(plan.counts, { upstream: 0, local: 0, conflict: 1, agreed: 0 });
  assert.equal(plan.clean, false);
  assert.deepEqual(plan.conflicts, ["h1"]);
  const region = plan.regions[0];
  assert.equal(region.recommended, null);
  assert.equal(region.base.text, "team: acme\n");
  assert.equal(region.local.text, "team: acme-eu\n");
  assert.equal(region.template.text, "team: acme-global\n");

  // Noninteractive ambiguity: a conflict cannot be resolved by default.
  assert.throws(() => applyConfigMerge(local, plan, {}), (e) => e.code === "E_SYNC_AMBIGUOUS" && /conflict/.test(e.message));

  assert.equal(applyConfigMerge(local, plan, { h1: "local" }).text, local);
  assert.equal(applyConfigMerge(local, plan, { h1: "package" }).text, template);
  const edited = applyConfigMerge(local, plan, { h1: { edit: "team: acme-eu-global\n" } });
  assert.equal(edited.text, HAND_EDITED.replace("team: acme", "team: acme-eu-global"));
  assert.deepEqual(edited.applied, [{ id: "h1", kind: "conflict", choice: "edit" }]);
});

test("one conflict does not block the independent upstream and local regions around it", () => {
  const base = ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5", "f: 6"].join("\n");
  const local = ["a: 1", "b: local", "c: 3", "d: 4", "e: 5", "f: local-only"].join("\n");
  const template = ["a: 1", "b: upstream", "c: 3", "d: upstream", "e: 5", "f: 6"].join("\n");

  const plan = planConfigMerge(base, local, template);
  assert.deepEqual(plan.counts, { upstream: 1, local: 1, conflict: 1, agreed: 0 });
  assert.deepEqual(plan.regions.map((r) => r.kind), ["conflict", "upstream", "local"]);
  const { text } = applyConfigMerge(local, plan, { [plan.regions[0].id]: "package" });
  assert.equal(text, ["a: 1", "b: upstream", "c: 3", "d: upstream", "e: 5", "f: local-only"].join("\n"));
});

test("an upstream edit ADJACENT to a local edit is one conflict, not a silently applied neighbour", () => {
  // The template changed `a` and `b`; the local file changed only `b`. Those
  // are one contiguous disputed span, so `a` cannot be applied behind the
  // user's back while `b` is still being decided — the whole span is offered
  // as a single local/package/edit choice.
  const base = ["a: 1", "b: 2", "c: 3"].join("\n");
  const local = ["a: 1", "b: local", "c: 3"].join("\n");
  const template = ["a: upstream", "b: upstream", "c: 3"].join("\n");

  const plan = planConfigMerge(base, local, template);
  assert.deepEqual(plan.counts, { upstream: 0, local: 0, conflict: 1, agreed: 0 });
  assert.equal(plan.regions[0].local.text, "a: 1\nb: local\n");
  assert.equal(plan.regions[0].template.text, "a: upstream\nb: upstream\n");
  assert.throws(() => applyConfigMerge(local, plan, {}), (e) => e.code === "E_SYNC_AMBIGUOUS");
});

test("upstream deletions, insertions at both ends, and the missing trailing newline all survive apply", () => {
  const base = "keep: 1\ndrop: 2\ntail: 3\n";
  const local = "keep: 1\ndrop: 2\ntail: 3\n";
  const template = "head: 0\nkeep: 1\ntail: 3\nfoot: 4";

  const plan = planConfigMerge(base, local, template);
  assert.equal(plan.counts.conflict, 0);
  const { text } = applyConfigMerge(local, plan, {});
  assert.equal(text, template);

  // No trailing newline on the local side is a byte the merge must not add.
  const noNewline = "keep: 1\ntail: 3";
  const plan2 = planConfigMerge(noNewline, noNewline, noNewline);
  assert.equal(applyConfigMerge(noNewline, plan2, {}).text, noNewline);
});

test("a line differing only in its terminator is a real difference, not a silent rewrite", () => {
  const base = "a: 1\nb: 2\n";
  const local = "a: 1\nb: 2\n";
  const template = "a: 1\r\nb: 2\r\n";
  const plan = planConfigMerge(base, local, template);
  assert.equal(plan.counts.upstream, 1);
  // Keeping the recommendation would adopt CRLF; keeping local leaves the file untouched.
  assert.equal(applyConfigMerge(local, plan, { h1: "local" }).text, local);
});

test("an edit decision cannot glue two YAML lines together, but may end the file without a newline", () => {
  const base = "a: 1\nb: 2\nc: 3\n";
  const local = "a: 1\nb: local\nc: 3\n";
  const template = "a: 1\nb: upstream\nc: 3\n";
  const plan = planConfigMerge(base, local, template);
  assert.equal(applyConfigMerge(local, plan, { h1: { edit: "b: merged" } }).text, "a: 1\nb: merged\nc: 3\n");

  const tailBase = "a: 1\nb: 2\n";
  const tailLocal = "a: 1\nb: local\n";
  const tailTemplate = "a: 1\nb: upstream\n";
  const tailPlan = planConfigMerge(tailBase, tailLocal, tailTemplate);
  assert.equal(applyConfigMerge(tailLocal, tailPlan, { h1: { edit: "b: merged" } }).text, "a: 1\nb: merged");
});

test("merge decisions fail closed: stale plan, unknown region, malformed decision, oversized input", () => {
  const base = "a: 1\n";
  const local = "a: local\n";
  const template = "a: upstream\n";
  const plan = planConfigMerge(base, local, template);

  assert.throws(() => applyConfigMerge("a: changed underneath\n", plan, { h1: "local" }),
    (e) => e.code === "E_SYNC_STALE_PLAN");
  assert.throws(() => applyConfigMerge(local, plan, { h9: "local" }),
    (e) => e.code === "E_SYNC_UNKNOWN_REGION");
  assert.throws(() => applyConfigMerge(local, plan, { h1: "upstream" }),
    (e) => e.code === "E_SYNC_BAD_DECISION");
  assert.throws(() => applyConfigMerge(local, plan, { h1: { edit: 42 } }),
    (e) => e.code === "E_SYNC_BAD_DECISION");

  const huge = `${"x: 1\n".repeat(2100)}`;
  assert.throws(() => planConfigMerge(huge, `y: 0\n${huge}`, huge), (e) => e.code === "E_SYNC_TOO_LARGE");
});

test("byte-preservation invariants hold over randomized three-way inputs", () => {
  // Deterministic PRNG — a byte-preservation failure must be reproducible.
  let seed = 20260729;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const mutate = (lines) => {
    const out = [];
    for (const line of lines) {
      const roll = rnd(10);
      if (roll < 2) continue;                                    // delete
      if (roll < 4) out.push(`${line}   # touched ${rnd(100)}`);  // change
      else out.push(line);
      if (roll === 9) out.push(`inserted-${rnd(1000)}: yes`);     // insert
    }
    return out;
  };
  const join = (lines) => (lines.length ? `${lines.join("\n")}\n` : "");

  for (let round = 0; round < 200; round++) {
    const baseLines = Array.from({ length: 1 + rnd(14) }, (_, i) => (rnd(4) ? `key${i}: ${rnd(50)}` : `# comment ${i}`));
    const base = join(baseLines);
    const local = join(mutate(baseLines));
    const template = join(mutate(baseLines));
    const plan = planConfigMerge(base, local, template);
    const where = `round ${round}\nbase=${JSON.stringify(base)}\nlocal=${JSON.stringify(local)}\ntemplate=${JSON.stringify(template)}`;

    // 1. Choosing the local side everywhere is a guaranteed no-op, byte for byte.
    const keepLocal = Object.fromEntries(plan.regions.map((r) => [r.id, "local"]));
    assert.equal(applyConfigMerge(local, plan, keepLocal).text, local, `keep-local not byte-identical — ${where}`);

    // 2. Choosing the package side everywhere reconstructs the template exactly:
    //    the regions and the untouched spans between them must together account
    //    for every byte of both files, or the splice geometry is wrong.
    const takePackage = Object.fromEntries(plan.regions.map((r) => [r.id, "package"]));
    assert.equal(applyConfigMerge(local, plan, takePackage).text, template, `take-package did not reconstruct the template — ${where}`);

    // 3. Regions are disjoint and ordered in the local file.
    let cursor = 0;
    for (const r of plan.regions) {
      assert.ok(r.local.start >= cursor && r.local.end >= r.local.start, `region ${r.id} overlaps or inverts — ${where}`);
      cursor = r.local.end;
    }

    // 4. Every region's recorded slice text really is the file's bytes there.
    const localLines = splitConfigLines(local);
    const templateLines = splitConfigLines(template);
    for (const r of plan.regions) {
      assert.equal(r.local.text, localLines.slice(r.local.start, r.local.end).join(""), `region ${r.id} local slice drifted — ${where}`);
      assert.equal(r.template.text, templateLines.slice(r.template.start, r.template.end).join(""), `region ${r.id} template slice drifted — ${where}`);
    }
  }
});

test("a plan region binds to the exact three texts it was computed from", () => {
  const a = planConfigMerge("a: 1\n", "a: local\n", "a: upstream\n");
  const b = planConfigMerge("a: 1\n", "a: local\n", "a: other\n");
  assert.notEqual(a.regions[0].digest, b.regions[0].digest);
  assert.notEqual(a.planDigest, b.planDigest);
  assert.equal(a.planDigest, planConfigMerge("a: 1\n", "a: local\n", "a: upstream\n").planDigest);
});

// ---------- guided template adoption transaction ----------

/** A materialization-era package: one capability root plus one config template. */
function materializedPackage(dir, { id = "example.engineering", version = "1.0.0", capability = "example.review", body = "hi", templates } = {}) {
  write(join(dir, "capabilities/example-review/oas.json"), JSON.stringify({ capability, version, description: "Review capability." }, null, 2));
  write(join(dir, "capabilities/example-review/skills/review/SKILL.md"), `# review\n${body}\n`);
  write(join(dir, "config-templates/default/oas-config.yaml"), "# adopt me\nname: workspace\n\ncapabilities:\n  additive:\n    example.review: {}\n");
  write(join(dir, "oas-package.json"), JSON.stringify({
    package: id, version, description: "Engineering package.", compatibility: { oas: ">=0.19.0" },
    capabilities: ["capabilities/example-review"],
    configTemplates: templates ?? { default: { path: "config-templates/default/oas-config.yaml", description: "Recommended setup", default: true } },
  }, null, 2));
  return dir;
}

test("init --package is ADOPTION, not an install alias: default template selection, and refusals mutate nothing", () => {
  const pkg = materializedPackage(temp());

  // No --config still adopts: the single marked default.
  const scope = temp();
  const ok = cli(["init", "--package", pkg, "--dir", scope, "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  const okPayload = JSON.parse(ok.stdout).result;
  assert.equal(okPayload.adopted, true);
  assert.equal(okPayload.template, "default");
  assert.equal(existsSync(join(scope, "oas-config.yaml")), true);
  assert.equal(existsSync(join(scope, ".agents/config-templates/adopted/example.engineering/default/adoption.json")), true);

  // Several unmarked templates: ambiguous, and the scope stays untouched
  // because the refusal happens inside the pre-commit gate.
  const ambiguous = materializedPackage(temp(), {
    templates: { a: { path: "config-templates/default/oas-config.yaml" }, b: { path: "config-templates/default/oas-config.yaml" } },
  });
  const scope2 = temp();
  const amb = cli(["init", "--package", ambiguous, "--dir", scope2, "--json"]);
  assert.equal(amb.status, 1);
  assert.equal(JSON.parse(amb.stdout).error.code, "E_TEMPLATE_AMBIGUOUS");
  assert.deepEqual(readdirSync(scope2), [], "an ambiguous refusal must not create a lock, a store, or an anchor");

  // A named template that does not exist, and a package with no templates.
  const scope3 = temp();
  const missing = cli(["init", "--package", pkg, "--config", "nope", "--dir", scope3, "--json"]);
  assert.equal(JSON.parse(missing.stdout).error.code, "E_TEMPLATE_NOT_FOUND");
  assert.deepEqual(readdirSync(scope3), []);

  const noTemplates = materializedPackage(temp(), { templates: {} });
  const scope4 = temp();
  const none = cli(["init", "--package", noTemplates, "--dir", scope4, "--json"]);
  assert.equal(JSON.parse(none.stdout).error.code, "E_NO_TEMPLATES");
  assert.deepEqual(readdirSync(scope4), []);

  for (const d of [pkg, scope, ambiguous, scope2, scope3, noTemplates, scope4]) rmSync(d, { recursive: true, force: true });
});

test("a journal that cannot even be constructed still yields exactly one JSON envelope", () => {
  const scope = temp();
  const outside = temp();
  mkdirSync(join(scope, ".agents"), { recursive: true });
  // An intermediate symlink leaving the scope: the journal refuses to snapshot
  // through it, and that refusal happens before anything is acquired.
  symlinkSync(outside, join(scope, ".agents/capabilities"));
  const pkg = materializedPackage(temp());

  const r = cli(["init", "--package", pkg, "--dir", scope, "--json"]);
  assert.equal(r.status, 1);
  // Exactly one envelope on stdout — not a stack trace, not two objects.
  const parsed = JSON.parse(r.stdout);
  assert.equal(r.stdout.trimEnd().split("\n").length, 1, "stdout must carry ONE envelope and nothing else");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.error.code, "E_JOURNAL_PATH_ESCAPE");
  assert.doesNotMatch(r.stdout, /at .*\(.*:\d+:\d+\)/, "no stack trace may reach stdout");

  // And nothing was acquired or written.
  assert.equal(existsSync(join(scope, "oas-lock.json")), false);
  assert.equal(existsSync(join(scope, "oas-config.yaml")), false);
  assert.deepEqual(readdirSync(outside), [], "the escaping target must be untouched");

  for (const d of [scope, outside, pkg]) rmSync(d, { recursive: true, force: true });
});

test("adoption failure AFTER the engine commits rolls the whole run back: pre-existing same-name capability, lock, ignore and base return", () => {
  const scope = temp();
  execFileSync("git", ["init", "-q", scope]); // Git-backed, so the ignore file is part of the transaction
  const pkg = materializedPackage(temp(), { version: "1.0.0", body: "ORIGINAL BYTES" });

  // Pre-existing state: the capability is already installed (via install, which
  // writes no config), so the later init --package touches the SAME capability.
  const seeded = cli(["install", pkg, "--dir", scope]);
  assert.equal(seeded.status, 0, seeded.stderr);
  const capDir = join(scope, ".agents/capabilities/installed/example.review");
  const skill = join(capDir, "skills/review/SKILL.md");

  // Drift the installed artifact. Re-acquiring the same locked package then
  // REPROJECTS it, which is what makes the engine actually commit a replacement
  // of a pre-existing same-name capability before our adoption write runs.
  // Without this the run would be refused at integrity-drift and never reach
  // the post-commit path this test exists to cover.
  writeFileSync(skill, "# review\nDRIFTED ON DISK\n");
  const before = {
    skill: readFileSync(skill),
    provenance: readFileSync(join(capDir, ".oas-installation.json")),
    lock: readFileSync(join(scope, "oas-lock.json")),
    ignore: readFileSync(join(scope, ".agents/capabilities/.gitignore")),
  };

  // Injected post-engine failure: the adopted-base directory path is occupied
  // by a FILE, so the adoption write fails only after the engine committed.
  write(join(scope, ".agents/config-templates"), "not a directory\n");

  const failed = cli(["init", "--package", pkg, "--dir", scope, "--json"]);
  assert.equal(failed.status, 1, "the run must fail");
  const err = JSON.parse(failed.stdout).error;
  assert.equal(err.code, "E_ADOPT_FAILED", "a CLI-owned write failure needs a stable code, not a raw errno");
  assert.match(err.message, /after the package was installed/);

  // Every pre-command byte is back — including the drifted artifact, because
  // rollback restores the state the command STARTED from, not an idealised one.
  assert.deepEqual(readFileSync(skill), before.skill, "the pre-existing same-name capability artifact must return byte-identically");
  assert.deepEqual(readFileSync(join(capDir, ".oas-installation.json")), before.provenance, "provenance must return byte-identically");
  assert.deepEqual(readFileSync(join(scope, "oas-lock.json")), before.lock, "the pre-command lock must return byte-identically");
  assert.deepEqual(readFileSync(join(scope, ".agents/capabilities/.gitignore")), before.ignore, "the ignore bytes must return");
  assert.equal(existsSync(join(scope, "oas-config.yaml")), false, "no config may survive a failed adoption");
  assert.equal(existsSync(join(scope, ".agents/config-templates/adopted")), false, "no adopted base may survive a failed adoption");

  for (const d of [scope, pkg]) rmSync(d, { recursive: true, force: true });
});

test("oas --help documents the implemented template commands and carries no retired vocabulary", () => {
  const help = cli(["--help"]).stdout;

  // The vocabulary is templates and adopted bases. "profile", "snapshot" and
  // "package store" all named things this architecture removed; leaving them in
  // help is how users end up looking for commands that no longer exist.
  for (const retired of [/profile/i, /snapshot/i, /package store/i]) {
    assert.doesNotMatch(help, retired, `retired vocabulary still in oas --help: ${retired}`);
  }

  // Every implemented form is documented.
  assert.match(help, /oas config diff \[--config <template>\]/);
  assert.match(help, /oas config sync \[--accept <r>=local\|package\]/);
  assert.match(help, /oas config sync --reset --yes/);
  assert.match(help, /oas config adopt <package>/);
  assert.match(help, /oas init \[--raw\]/);
  assert.match(help, /adopt one config TEMPLATE from a package/);

  // And the flags those forms depend on.
  for (const flag of ["--accept", "--reset", "--yes", "--config <template>"]) {
    assert.ok(help.includes(flag), `oas --help omits ${flag}`);
  }

  // Help must not promise a command that is not wired: every documented
  // `oas config <sub>` has to be one the dispatcher accepts.
  for (const sub of [...help.matchAll(/oas config (\w+)/g)].map((m) => m[1])) {
    assert.ok(["diff", "sync", "adopt"].includes(sub), `oas --help documents an unimplemented subcommand: config ${sub}`);
  }
});

// ---------- oas config sync / --reset / adopt ----------

/** Publish a new template body (and version) for an already-installed fixture. */
function republish(pkgDir, body, version) {
  write(join(pkgDir, "config-templates/default/oas-config.yaml"), body);
  const manifest = JSON.parse(readFileSync(join(pkgDir, "oas-package.json"), "utf8"));
  manifest.version = version;
  write(join(pkgDir, "oas-package.json"), JSON.stringify(manifest, null, 2));
}

const TEMPLATE_V1 = "# template header — do not lose me\nname: workspace\n\ncapabilities:\n  additive:\n    example.review: {}\n";

test("config sync applies upstream-only changes and leaves every other local byte identical", () => {
  const pkg = materializedPackage(temp());
  write(join(pkg, "config-templates/default/oas-config.yaml"), TEMPLATE_V1);
  const scope = temp();
  const initRun = cli(["init", "--package", pkg, "--dir", scope]);
  assert.equal(initRun.status, 0, `init: ${initRun.stderr}`);

  // Hand edit near the TOP, with deliberate spacing and a trailing comment.
  const file = join(scope, "oas-config.yaml");
  const local = TEMPLATE_V1.replace("name: workspace", "name: acme     # our name, keep it exactly");
  writeFileSync(file, local);

  // Upstream changes a region genuinely far from the local edit — three
  // unchanged lines apart. Anything closer would ENTANGLE with it into one
  // conflict, which is correct behaviour but not what this case is about.
  republish(pkg, `${TEMPLATE_V1}    example.audit: {}\n`, "1.1.0");
  const upd = cli(["update", "example.engineering", "--dir", scope]);
  assert.equal(upd.status, 0, `update: ${upd.stderr}`);

  const r = cli(["config", "sync", "--dir", scope, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout).result;
  assert.equal(payload.changed, true);
  assert.equal(payload.baseAdvanced, true);
  assert.deepEqual(payload.applied.map((a) => a.kind), ["upstream"]);

  const after = readFileSync(file, "utf8");
  assert.match(after, /example\.audit: \{\}/, "the upstream addition must land");
  assert.match(after, /name: acme {5}# our name, keep it exactly/, "the local edit and its exact spacing must survive");
  assert.match(after, /^# template header — do not lose me$/m, "an untouched comment must survive verbatim");
  // Everything except the applied region is byte-identical to what we wrote.
  assert.equal(after, `${local}    example.audit: {}\n`);
  assert.equal(readFileSync(payload.backup, "utf8"), local, "the backup holds the pre-sync bytes");

  for (const d of [pkg, scope]) rmSync(d, { recursive: true, force: true });
});

test("config sync refuses noninteractive ambiguity, honours local/package choices, and records them so they are not re-asked", () => {
  const pkg = materializedPackage(temp());
  write(join(pkg, "config-templates/default/oas-config.yaml"), TEMPLATE_V1);
  const scope = temp();
  assert.equal(cli(["init", "--package", pkg, "--dir", scope]).status, 0);
  const file = join(scope, "oas-config.yaml");
  const local = TEMPLATE_V1.replace("    example.review: {}", "    example.review: { global: true }");
  writeFileSync(file, local);

  // Upstream touches the SAME line: a genuine conflict.
  republish(pkg, TEMPLATE_V1.replace("    example.review: {}", "    example.review: { agent-types: { dev: true } }"), "1.1.0");
  assert.equal(cli(["update", "example.engineering", "--dir", scope]).status, 0);

  // Noninteractive with no decision: fail closed, change nothing.
  const refused = cli(["config", "sync", "--dir", scope, "--json"]);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, "E_SYNC_AMBIGUOUS");
  assert.equal(readFileSync(file, "utf8"), local, "a refused sync must not touch a byte");

  // An explicit package choice applies it.
  const taken = cli(["config", "sync", "--accept", "h1=package", "--dir", scope, "--json"]);
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(readFileSync(file, "utf8"), /agent-types: \{ dev: true \}/);

  // The decision was recorded: syncing again has nothing to ask or do.
  const again = cli(["config", "sync", "--dir", scope, "--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).result.changed, false);

  for (const d of [pkg, scope]) rmSync(d, { recursive: true, force: true });
});

test("keeping local on every conflict still advances the base, so the same conflict is never re-presented", () => {
  const pkg = materializedPackage(temp());
  write(join(pkg, "config-templates/default/oas-config.yaml"), TEMPLATE_V1);
  const scope = temp();
  assert.equal(cli(["init", "--package", pkg, "--dir", scope]).status, 0);
  const file = join(scope, "oas-config.yaml");
  const local = TEMPLATE_V1.replace("    example.review: {}", "    example.review: { global: true }");
  writeFileSync(file, local);
  republish(pkg, TEMPLATE_V1.replace("    example.review: {}", "    example.review: { global: false }"), "1.1.0");
  assert.equal(cli(["update", "example.engineering", "--dir", scope]).status, 0);

  const kept = cli(["config", "sync", "--accept", "h1=local", "--dir", scope, "--json"]);
  assert.equal(kept.status, 0, kept.stderr);
  const payload = JSON.parse(kept.stdout).result;
  assert.equal(payload.changed, false, "keeping local changes no bytes");
  assert.equal(payload.baseAdvanced, true, "but the decision must still be recorded");
  assert.equal(readFileSync(file, "utf8"), local);

  // Without base advancement this would raise the identical conflict forever.
  const second = cli(["config", "sync", "--dir", scope, "--json"]);
  assert.equal(second.status, 0, "the resolved conflict must not come back");
  assert.equal(JSON.parse(second.stdout).result.changed, false);

  for (const d of [pkg, scope]) rmSync(d, { recursive: true, force: true });
});

test("config sync --reset previews the loss, demands explicit acceptance, and keeps a recoverable backup", () => {
  const pkg = materializedPackage(temp());
  write(join(pkg, "config-templates/default/oas-config.yaml"), TEMPLATE_V1);
  const scope = temp();
  assert.equal(cli(["init", "--package", pkg, "--dir", scope]).status, 0);
  const file = join(scope, "oas-config.yaml");
  const local = `${TEMPLATE_V1}\n# months of local policy\nagent-types:\n  dev: {}\n`;
  writeFileSync(file, local);

  // Noninteractive without acceptance: refuse, change nothing.
  const refused = cli(["config", "sync", "--reset", "--dir", scope, "--json"]);
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, "E_RESET_NOT_CONFIRMED");
  assert.equal(readFileSync(file, "utf8"), local, "a refused reset must not touch a byte");

  const done = cli(["config", "sync", "--reset", "--yes", "--dir", scope, "--json"]);
  assert.equal(done.status, 0, done.stderr);
  const payload = JSON.parse(done.stdout).result;
  assert.equal(payload.action, "reset");
  assert.ok(payload.discardedRegions >= 1);
  assert.equal(readFileSync(file, "utf8"), TEMPLATE_V1, "reset replaces the config with the template verbatim");
  assert.equal(readFileSync(payload.backup, "utf8"), local, "the discarded local policy must be recoverable");

  for (const d of [pkg, scope]) rmSync(d, { recursive: true, force: true });
});

test("config adopt switches base: exactly one survives on success, and a failure leaves everything unchanged", () => {
  const first = materializedPackage(temp(), { id: "first.pkg", capability: "first.cap" });
  write(join(first, "config-templates/default/oas-config.yaml"), "# first\nname: workspace\n");
  const second = materializedPackage(temp(), { id: "second.pkg", capability: "second.cap" });
  write(join(second, "config-templates/default/oas-config.yaml"), "# second\nname: workspace\nsettings:\n  x: 1\n");

  const scope = temp();
  assert.equal(cli(["init", "--package", first, "--dir", scope]).status, 0);
  assert.equal(cli(["install", second, "--dir", scope]).status, 0);
  const adoptedRoot = join(scope, ".agents/config-templates/adopted");
  assert.deepEqual(readdirSync(adoptedRoot), ["first.pkg"]);

  const r = cli(["config", "adopt", "second.pkg", "--dir", scope, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(adoptedRoot), ["second.pkg"], "exactly one adopted base may survive a switch");
  assert.match(readFileSync(join(scope, "oas-config.yaml"), "utf8"), /settings:/);

  // A failed switch changes nothing: the package is not installed here.
  const before = readFileSync(join(scope, "oas-config.yaml"), "utf8");
  const failed = cli(["config", "adopt", "absent.pkg", "--dir", scope, "--json"]);
  assert.equal(failed.status, 1);
  assert.deepEqual(readdirSync(adoptedRoot), ["second.pkg"], "a failed switch must leave the prior base in place");
  assert.equal(readFileSync(join(scope, "oas-config.yaml"), "utf8"), before);

  for (const d of [first, second, scope]) rmSync(d, { recursive: true, force: true });
});

// ---------- run-level rollback journal (CLI-private) ----------
//
// The run-level guarantee — a later failure rolls back only THIS run's changes
// and leaves pre-existing bytes/artifacts identical — spans artifacts no single
// engine call covers, so the CLI owns it. These tests exercise the mechanism
// against real filesystem state; no engine symbol is involved.

/** Exact fingerprint of a tree: relative path, type, mode, and content or link
 * target. Two trees with equal fingerprints are byte- and behaviour-identical
 * for our purposes, which is what "restored exactly" has to mean. */
function fingerprint(root) {
  const out = [];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) out.push(`${rel} symlink -> ${readlinkSync(abs)}`);
      else if (st.isDirectory()) { out.push(`${rel} dir ${(st.mode & 0o777).toString(8)}`); walk(abs, rel); }
      else out.push(`${rel} file ${(st.mode & 0o777).toString(8)} ${readFileSync(abs).toString("base64")}`);
    }
  };
  walk(root, "");
  return out.join("\n");
}

/** A scope with a pre-existing installed capability, lock, config, ignore file
 * and adopted base — i.e. the state a second run must not damage. */
function populatedScope({ git = false } = {}) {
  const dir = temp();
  write(join(dir, "oas-config.yaml"), "# hand written\nname: acme\n");
  write(join(dir, "oas-lock.json"), JSON.stringify({ lockfileVersion: 2, packages: {}, capabilities: {} }, null, 2));
  write(join(dir, ".agents/capabilities/.gitignore"), "installed/\n");
  write(join(dir, ".agents/capabilities/installed/example.review/oas.json"), '{"capability":"example.review"}');
  write(join(dir, ".agents/capabilities/installed/example.review/.oas-installation.json"), '{"package":"example.engineering"}');
  writeFileSync(join(dir, ".agents/capabilities/installed/example.review/run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  symlinkSync("./oas.json", join(dir, ".agents/capabilities/installed/example.review/manifest-link"));
  write(join(dir, ".agents/capabilities/owned/acme.local/oas.json"), '{"capability":"acme.local"}');
  write(join(dir, ".agents/config-templates/adopted/example.engineering/default/oas-config.yaml"), "name: acme\n");
  write(join(dir, ".agents/config-templates/adopted/example.engineering/default/adoption.json"), '{"template":"default"}');
  if (git) gitRepo(dir);
  return dir;
}

test("run journal restores a scope byte-identically after a failed multi-step run (Git and non-Git layouts)", () => {
  for (const git of [false, true]) {
    const dir = populatedScope({ git });
    const before = fingerprint(dir);
    const journal = beginRunJournal(dir);

    // A run that gets a long way in before failing: rewrites the config, the
    // lock, the ignore file and the adopted base, replaces the pre-existing
    // same-name capability, and adds a new one.
    writeFileSync(join(dir, "oas-config.yaml"), "name: rewritten-by-the-run\n");
    writeFileSync(join(dir, "oas-lock.json"), '{"lockfileVersion":2,"packages":{"x":{}},"capabilities":{}}');
    writeFileSync(join(dir, ".agents/capabilities/.gitignore"), "installed/\nowned/\n");
    rmSync(join(dir, ".agents/capabilities/installed/example.review"), { recursive: true, force: true });
    write(join(dir, ".agents/capabilities/installed/example.review/oas.json"), '{"capability":"example.review","version":"9.9.9"}');
    write(join(dir, ".agents/capabilities/installed/example.audit/oas.json"), '{"capability":"example.audit"}');
    write(join(dir, ".agents/config-templates/adopted/other.package/default/oas-config.yaml"), "name: other\n");

    // Proof the assertion below has teeth: without the rollback, the scope is
    // genuinely different. A restore test that would also pass against a no-op
    // rollback measures nothing.
    assert.notEqual(fingerprint(dir), before, "fixture failed to mutate the scope");

    const report = journal.rollback();
    assert.equal(report.complete, true, `rollback reported incomplete: ${report.summary}`);
    assert.equal(fingerprint(dir), before, `scope not byte-identical after rollback (git=${git})`);
    // The owned capability was never in the blast radius.
    assert.equal(readFileSync(join(dir, ".agents/capabilities/owned/acme.local/oas.json"), "utf8"), '{"capability":"acme.local"}');
    assert.equal(existsSync(journal.backupDir), false, "a complete rollback must clean its backup");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run journal blocker regression: a pre-existing same-name capability, its provenance, lock and adopted base return exactly", () => {
  const dir = populatedScope();
  const capDir = join(dir, ".agents/capabilities/installed/example.review");
  const originalManifest = readFileSync(join(capDir, "oas.json"));
  const originalProvenance = readFileSync(join(capDir, ".oas-installation.json"));
  const originalLock = readFileSync(join(dir, "oas-lock.json"));
  const originalBase = readFileSync(join(dir, ".agents/config-templates/adopted/example.engineering/default/oas-config.yaml"));
  const originalMode = lstatSync(join(capDir, "run.sh")).mode & 0o777;

  const journal = beginRunJournal(dir);
  // The run materializes over the SAME capability id, rewrites its provenance
  // and the lock, advances the adopted base — then fails.
  writeFileSync(join(capDir, "oas.json"), '{"capability":"example.review","version":"2.0.0"}');
  writeFileSync(join(capDir, ".oas-installation.json"), '{"package":"someone.else"}');
  writeFileSync(join(capDir, "run.sh"), "#!/bin/sh\nrm -rf /\n", { mode: 0o644 });
  rmSync(join(capDir, "manifest-link"), { force: true });
  writeFileSync(join(dir, "oas-lock.json"), "{}");
  writeFileSync(join(dir, ".agents/config-templates/adopted/example.engineering/default/oas-config.yaml"), "name: upstream\n");

  assert.equal(journal.rollback().complete, true);
  assert.deepEqual(readFileSync(join(capDir, "oas.json")), originalManifest);
  assert.deepEqual(readFileSync(join(capDir, ".oas-installation.json")), originalProvenance);
  assert.deepEqual(readFileSync(join(dir, "oas-lock.json")), originalLock);
  assert.deepEqual(readFileSync(join(dir, ".agents/config-templates/adopted/example.engineering/default/oas-config.yaml")), originalBase);
  assert.equal(lstatSync(join(capDir, "run.sh")).mode & 0o777, originalMode, "executable bit must survive rollback");
  assert.equal(lstatSync(join(capDir, "manifest-link")).isSymbolicLink(), true, "symlink must be restored as a symlink");
  assert.equal(readlinkSync(join(capDir, "manifest-link")), "./oas.json");
  rmSync(dir, { recursive: true, force: true });
});

test("run journal removes what the run created, including the .agents anchor, but only while empty", () => {
  const bare = temp();
  const journal = beginRunJournal(bare);
  assert.equal(journal.anchorCreatedByRun, true);

  write(join(bare, "oas-config.yaml"), "name: fresh\n");
  write(join(bare, "oas-lock.json"), "{}");
  write(join(bare, ".agents/capabilities/.gitignore"), "installed/\n");
  write(join(bare, ".agents/capabilities/installed/example.review/oas.json"), "{}");
  write(join(bare, ".agents/config-templates/adopted/example.engineering/default/adoption.json"), "{}");

  assert.notEqual(fingerprint(bare), "", "fixture failed to create anything to remove");
  assert.equal(journal.rollback().complete, true);
  assert.equal(fingerprint(bare), "", "a fresh-scope rollback must leave nothing behind, anchor included");
  rmSync(bare, { recursive: true, force: true });

  // Same run, but the scope also holds an owned capability the run never made:
  // the anchor is NOT ours to delete once something else lives under it.
  const withOwned = temp();
  write(join(withOwned, ".agents/capabilities/owned/acme.local/oas.json"), "{}");
  const j2 = beginRunJournal(withOwned);
  assert.equal(j2.anchorCreatedByRun, false);
  write(join(withOwned, ".agents/capabilities/installed/example.review/oas.json"), "{}");
  write(join(withOwned, ".agents/capabilities/.gitignore"), "installed/\n");
  assert.equal(j2.rollback().complete, true);
  assert.equal(existsSync(join(withOwned, ".agents/capabilities/owned/acme.local/oas.json")), true);
  assert.equal(existsSync(join(withOwned, ".agents/capabilities/installed")), false);
  assert.equal(existsSync(join(withOwned, ".agents/capabilities/.gitignore")), false);
  rmSync(withOwned, { recursive: true, force: true });
});

test("run journal restores the capability .gitignore's prior bytes, and its prior ABSENCE", () => {
  // Prior bytes: the engine's transactional ensure rewrote it; rollback undoes that.
  const withIgnore = populatedScope();
  const j1 = beginRunJournal(withIgnore);
  writeFileSync(join(withIgnore, ".agents/capabilities/.gitignore"), "installed/\nowned/\nadopted/\n");
  assert.equal(j1.rollback().complete, true);
  assert.equal(readFileSync(join(withIgnore, ".agents/capabilities/.gitignore"), "utf8"), "installed/\n");
  rmSync(withIgnore, { recursive: true, force: true });

  // Prior absence: the engine created it during an operation that succeeded
  // before the run failed later — compensating it is the CLI journal's job.
  const withoutIgnore = temp();
  write(join(withoutIgnore, ".agents/capabilities/owned/acme.local/oas.json"), "{}");
  const j2 = beginRunJournal(withoutIgnore);
  write(join(withoutIgnore, ".agents/capabilities/.gitignore"), "installed/\n");
  assert.equal(j2.rollback().complete, true);
  assert.equal(existsSync(join(withoutIgnore, ".agents/capabilities/.gitignore")), false);
  rmSync(withoutIgnore, { recursive: true, force: true });
});

test("run journal rollback is truthful about partial failure instead of hiding it", { skip: process.getuid?.() === 0 ? "runs as root: permissions cannot be enforced" : false }, () => {
  const dir = populatedScope();
  const journal = beginRunJournal(dir);
  writeFileSync(join(dir, "oas-config.yaml"), "name: rewritten\n");
  writeFileSync(join(dir, "oas-lock.json"), "{}");

  // Injected failure: make the scope directory unwritable so the config cannot
  // be replaced, while the artifacts under .agents still can be.
  chmodSync(dir, 0o500);
  let report;
  try { report = journal.rollback(); } finally { chmodSync(dir, 0o700); }

  assert.equal(report.complete, false);
  assert.match(report.summary, /^ROLLBACK INCOMPLETE — /);
  assert.match(report.summary, /oas-config\.yaml/);
  assert.ok(report.failures.length > 0, "failures must be enumerated, not summarised away");
  assert.equal(existsSync(journal.backupDir), true, "an incomplete rollback must KEEP the backup — it is the only surviving copy");

  // Recoverable: with the permission restored, rolling back again completes.
  const second = journal.rollback();
  assert.equal(second.complete, true, second.summary);
  assert.equal(readFileSync(join(dir, "oas-config.yaml"), "utf8"), "# hand written\nname: acme\n");
  rmSync(dir, { recursive: true, force: true });
});

test("run journal finalize and rollback are idempotent, mutually exclusive, and clean up the backup", () => {
  const dir = populatedScope();
  const j1 = beginRunJournal(dir);
  writeFileSync(join(dir, "oas-config.yaml"), "name: kept\n");
  j1.finalize();
  j1.finalize(); // idempotent
  assert.equal(existsSync(j1.backupDir), false);
  assert.equal(readFileSync(join(dir, "oas-config.yaml"), "utf8"), "name: kept\n", "finalize must never revert the run's work");
  assert.throws(() => j1.rollback(), (e) => e.code === "E_JOURNAL_FINALIZED");

  const j2 = beginRunJournal(dir);
  writeFileSync(join(dir, "oas-config.yaml"), "name: discarded\n");
  assert.equal(j2.rollback().complete, true);
  const again = j2.rollback(); // idempotent
  assert.equal(again.complete, true);
  assert.deepEqual([again.restored, again.removed], [[], []]);
  assert.throws(() => j2.finalize(), (e) => e.code === "E_JOURNAL_ROLLED_BACK");
  assert.equal(readFileSync(join(dir, "oas-config.yaml"), "utf8"), "name: kept\n");
  rmSync(dir, { recursive: true, force: true });
});

test("run journal keeps its backup outside the protected tree and refuses escaping paths", () => {
  const dir = populatedScope();
  const journal = beginRunJournal(dir);
  assert.equal(journal.backupDir.startsWith(`${dir}/`), false, "backup inside the scope would be destroyed by the restore it enables");
  journal.finalize();

  assert.throws(() => beginRunJournal(dir, { backupRoot: dir }), (e) => e.code === "E_JOURNAL_BACKUP_INSIDE_SCOPE");
  assert.throws(() => beginRunJournal(dir, { extraPaths: ["../outside.yaml"] }), (e) => e.code === "E_JOURNAL_PATH_ESCAPE");
  assert.throws(() => beginRunJournal(join(dir, "nope")), (e) => e.code === "E_JOURNAL_NO_SCOPE");

  // An INTERMEDIATE component that leaves the scope is fatal: restoring through
  // it would delete outer-scope state this run never owned.
  const escaped = temp();
  const outside = temp();
  mkdirSync(join(escaped, ".agents"), { recursive: true });
  symlinkSync(outside, join(escaped, ".agents/capabilities"));
  assert.throws(() => beginRunJournal(escaped), (e) => e.code === "E_JOURNAL_PATH_ESCAPE");

  // A CONTAINED alias is refused too: it makes two journal entries address the
  // same bytes, so restoring one would delete or overwrite the other and the
  // result would depend on entry order.
  const aliased = temp();
  mkdirSync(join(aliased, ".agents/real-capabilities"), { recursive: true });
  symlinkSync("./real-capabilities", join(aliased, ".agents/capabilities"));
  assert.throws(() => beginRunJournal(aliased), (e) => e.code === "E_JOURNAL_SYMLINK_COMPONENT");

  for (const d of [dir, escaped, outside, aliased]) rmSync(d, { recursive: true, force: true });
});

test("run journal leaves no backup residue when construction itself fails", { skip: process.getuid?.() === 0 ? "runs as root: permissions cannot be enforced" : false }, () => {
  const backupRoot = temp();
  const residue = () => readdirSync(backupRoot).filter((n) => n.startsWith("oas-run-journal-"));

  // Failure DURING snapshotting: the capability store cannot be read, so the
  // copy throws after the backup directory already exists.
  const dir = populatedScope();
  const store = join(dir, ".agents/capabilities/installed");
  chmodSync(store, 0o000);
  try {
    assert.throws(() => beginRunJournal(dir, { backupRoot }));
  } finally { chmodSync(store, 0o700); }
  assert.deepEqual(residue(), [], "a failed snapshot must not strand a partial backup");

  // Failure from a refused layout, after mkdtemp: same guarantee.
  const aliased = temp();
  mkdirSync(join(aliased, ".agents/real-capabilities"), { recursive: true });
  symlinkSync("./real-capabilities", join(aliased, ".agents/capabilities"));
  assert.throws(() => beginRunJournal(aliased, { backupRoot }), (e) => e.code === "E_JOURNAL_SYMLINK_COMPONENT");
  assert.deepEqual(residue(), []);

  // And the original typed error survives the cleanup rather than being masked.
  assert.throws(() => beginRunJournal(dir, { backupRoot, extraPaths: ["../escape.yaml"] }), (e) => e.code === "E_JOURNAL_PATH_ESCAPE");
  assert.deepEqual(residue(), []);

  for (const d of [dir, aliased, backupRoot]) rmSync(d, { recursive: true, force: true });
});

test("run journal path input is canonical, unique, and collision-free between a/b and a__b", () => {
  const dir = populatedScope();
  write(join(dir, "a/b"), "nested\n");
  write(join(dir, "a__b"), "flat\n");

  // Distinct artifacts whose flattened names are identical: a separator-
  // substitution backup key would restore one over the other.
  const journal = beginRunJournal(dir, { extraPaths: ["a/b", "a__b"] });
  writeFileSync(join(dir, "a/b"), "nested-clobbered\n");
  writeFileSync(join(dir, "a__b"), "flat-clobbered\n");
  assert.equal(journal.rollback().complete, true);
  assert.equal(readFileSync(join(dir, "a/b"), "utf8"), "nested\n");
  assert.equal(readFileSync(join(dir, "a__b"), "utf8"), "flat\n");

  // Fail-closed on ambiguous input rather than interpreting it.
  assert.throws(() => beginRunJournal(dir, { extraPaths: ["a/b", "a/b"] }), (e) => e.code === "E_JOURNAL_DUPLICATE_PATH");
  assert.throws(() => beginRunJournal(dir, { extraPaths: ["a/b", "./a/b"] }), (e) => e.code === "E_JOURNAL_DUPLICATE_PATH");
  assert.throws(() => beginRunJournal(dir, { extraPaths: ["oas-config.yaml"] }), (e) => e.code === "E_JOURNAL_DUPLICATE_PATH");
  assert.throws(() => beginRunJournal(dir, { extraPaths: [""] }), (e) => e.code === "E_JOURNAL_BAD_PATH");
  assert.throws(() => beginRunJournal(dir, { extraPaths: ["   "] }), (e) => e.code === "E_JOURNAL_BAD_PATH");
  assert.throws(() => beginRunJournal(dir, { extraPaths: ["."] }), (e) => e.code === "E_JOURNAL_BAD_PATH");
  assert.throws(() => beginRunJournal(dir, { extraPaths: ["a\\b"] }), (e) => e.code === "E_JOURNAL_BAD_PATH");
  assert.throws(() => beginRunJournal(dir, { extraPaths: [42] }), (e) => e.code === "E_JOURNAL_BAD_PATH");

  // Canonicalization is real: "./a//b" is the same entry as "a/b" and restores it.
  const j2 = beginRunJournal(dir, { extraPaths: ["./a//b"] });
  assert.ok(j2.protected.some((p) => p.path === "a/b"));
  writeFileSync(join(dir, "a/b"), "again\n");
  assert.equal(j2.rollback().complete, true);
  assert.equal(readFileSync(join(dir, "a/b"), "utf8"), "nested\n");
  rmSync(dir, { recursive: true, force: true });
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
  // Lock maps are null-prototype by contract, so a hostile package id spelled
  // "constructor" or "toString" cannot impersonate an entry via map[id].
  assert.equal(Object.getPrototypeOf(r2.packages), null);
  assert.equal(Object.getPrototypeOf(r2.capabilities), null);
  assert.equal(r2.packages.toString, undefined, "an inherited name must not resolve as a package");
  assert.deepEqual(Object.keys(r2.packages), []);
  assert.equal(r2.legacy.length, 1);
  assert.ok(r2.legacy[0].capabilities["old.cap"]);
  // an EMPTY v1 lock SURFACES as legacy with provenance (maintainer ruling,
  // upholding the original reviewer-0b4d132 requirement — implemented
  // engine-side in the corrected head)
  const ws3 = join(base, "ws3");
  write(join(ws3, "oas-config.yaml"), "name: ws3\n");
  write(join(ws3, "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: {} }));
  const r3 = readPackageLocks(ws3);
  assert.deepEqual(Object.keys(r3.packages), []);
  assert.equal(r3.legacy.length, 1, "empty v1 lock must not disappear from the envelope");
  assert.deepEqual(Object.keys(r3.legacy[0].capabilities), []);
  assert.equal(r3.legacy[0].level, ws3);
  assert.equal(r3.legacy[0].lockfileVersion, 1);
});

test("empty v1 locks: reconcile LEGACY rows, doctor pending-format-migration (distinct from residue), lock-only-scope discovery", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\n");
  // a lock-only descendant scope (NO oas-config.yaml) carrying an EMPTY v1 lock
  const member = join(ws, "member");
  write(join(member, "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: {} }));
  // (a) discovery includes lock-owning scopes without config entries
  assert.deepEqual(discoverWorkspaceScopes(ws), [member], "lock-only scopes are discovered");
  // (b) reconciliation surfaces the empty v1 file as a LEGACY row, exit 0
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /LEGACY\s+.*member\/oas-lock\.json/);
  // (c) doctor: pending lock-format migration line, DISTINCT from residue
  const d = cli(["doctor", member], { cwd: ws });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /empty lockfileVersion 1 file — pending lock-format migration/);
  assert.doesNotMatch(d.stdout, /migration residue/);
  // (d) doctor --json: legacyLockFiles entry (empty: true), migrationResidue stays empty
  const dj = JSON.parse(cli(["doctor", member, "--json"], { cwd: ws }).stdout);
  const lf = dj.legacyLockFiles.find((l) => l.level === member);
  assert.ok(lf, JSON.stringify(dj.legacyLockFiles));
  assert.equal(lf.empty, true);
  assert.equal(lf.status, "pending-format-migration");
  assert.deepEqual(dj.migrationResidue, [], "empty v1 is never capability residue");
});

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
  // entry shape passes the strict residue validator (b3ac4c6) so the failure
  // under test stays the unrestorable SOURCE, not a malformed-entry raise.
  write(join(ws, "member", "oas-lock.json"), JSON.stringify({ lockfileVersion: 1, capabilities: { "ghost.cap": { source: "path:/nonexistent-src", version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` } } }));
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

test("non-team bare install also verifies v2 package locks (chain path, no boundary)", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws");
  write(join(ws, "oas-config.yaml"), "name: ws\n"); // NO team:
  write(join(ws, "oas-lock.json"), lockV2({ source: `path:${pkg}`, capabilities: {
    "example.review": { path: "capabilities/example-review" },
    "example.delivery": { path: "capabilities/example-delivery" },
  } }));
  const r = cli(["install", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1, `non-team scope with a missing locked package must fail:\n${r.stdout}`);
  assert.match(r.stdout, /FAILED\s+package example\.engineering/);
  assert.doesNotMatch(r.stdout, /Nothing to restore/);
  // ancestor package locks are checked at a team boundary too
  const outer = join(base, "outer");
  const inner = join(outer, "team");
  write(join(outer, "oas-lock.json"), lockV2({ source: `path:${pkg}`, capabilities: {
    "example.review": { path: "capabilities/example-review" },
  } }));
  write(join(inner, "oas-config.yaml"), "name: team\nteam:\n  name: t\n");
  const r2 = cli(["install", "--no-requirements", "--dir", inner], { cwd: inner });
  assert.equal(r2.status, 1, `ancestor package lock must be checked at a team boundary:\n${r2.stdout}`);
  assert.match(r2.stdout, /FAILED\s+package example\.engineering/);
  // with the artifact properly acquired at a FRESH scope, everything is ok
  // (the drifted lock at ws now correctly blocks re-acquisition — 7b2cd36's
  // lock-integrity invariant — so the ok-path needs a clean scope)
  const ws2 = join(base, "ws2");
  write(join(ws2, "oas-config.yaml"), "name: ws2\n");
  installFixturePackage(ws2, pkg);
  const r3 = cli(["install", "--no-requirements", "--dir", ws2], { cwd: ws2 });
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
  // non-team chain path with a malformed lock too — actually invalid JSON,
  // asserted unconditionally: nonzero exit, one parseable failure envelope
  const ws4 = join(base, "ws4");
  write(join(ws4, "oas-config.yaml"), "name: ws\n");
  write(join(ws4, "oas-lock.json"), "{broken json");
  const broken2 = cli(["install", "--json", "--dir", ws4], { cwd: ws4 });
  assert.equal(broken2.status, 1, broken2.stdout);
  assert.equal(JSON.parse(broken2.stdout).ok, false, "chain path keeps the envelope on malformed locks");
});

// ---------- doctor ----------

test("doctor reports the adopted template base, local-edit state, and missing host commands", () => {
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
  assert.match(r.stdout, /Adopted config template: .*adopted example\.engineering:default/);
  assert.match(r.stdout, /local edits present/, "the config was hand-edited above, and doctor must say so");
  assert.match(r.stdout, /recorded base .*config-templates\/adopted\/example\.engineering\/default/);
  assert.match(r.stdout, /Missing host commands/);
  assert.match(r.stdout, /review-helper-not-here — reviews \(requested by: example\.review\)/);
  assert.match(r.stdout, /install with consent: oas install --accept-requirement review-helper-not-here/);

  // A second installed package exports templates nobody adopted. Doctor must
  // NOT enumerate them: in the flat model that list exists only behind a network
  // fetch of the locked source, and a diagnostic must never go to the network.
  const other = fixturePackage(join(base, "other"), { id: "other.pkg", capabilities: { "capabilities/other-cap": { capability: "other.cap", version: "1.0.0", description: "x" } } });
  installFixturePackage(ws, other);
  const r2 = cli(["doctor", ws], { cwd: ws });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /Installed packages:/);
  assert.match(r2.stdout, /other\.pkg@1\.0\.0/);
  assert.doesNotMatch(r2.stdout, /other\.pkg exports config template/, "doctor must not advertise templates it would have to fetch to enumerate");
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
  const other = fixturePackage(join(base, "other"), { id: "other.pkg", capabilities: { "capabilities/other-cap": { capability: "other.cap", version: "1.0.0", description: "x" } } });
  installFixturePackage(ws, other);

  const r = cli(["doctor", ws, "--json"], { cwd: ws });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout); // exactly one JSON document on stdout
  assert.equal(doc.schemaVersion, 1);
  // packages: lock v2 entries with provenance (init --package locked example.engineering per Gate 1)
  assert.deepEqual(doc.packages.map((p) => p.id).sort(), ["example.engineering", "other.pkg"]);
  assert.ok(doc.packages.every((p) => p.version === "1.0.0"));
  assert.deepEqual(doc.packages.find((p) => p.id === "other.pkg").capabilities, ["other.cap"]);
  // adoptedTemplates: the one recorded base, with the provenance the human
  // report renders and the local-edit state doctor computes without a fetch.
  assert.equal(doc.adoptedTemplates.length, 1);
  const adoptedRow = doc.adoptedTemplates[0];
  assert.equal(adoptedRow.package, "example.engineering");
  assert.equal(adoptedRow.template, "default");
  assert.equal(adoptedRow.status, "ok");
  assert.equal(typeof adoptedRow.localChanges, "boolean");
  assert.match(adoptedRow.hash, /^sha256-[0-9a-f]{64}$/);
  assert.ok(adoptedRow.base.endsWith("config-templates/adopted/example.engineering/default/oas-config.yaml"));
  // There is deliberately no "unapplied templates" field: enumerating those
  // would require fetching each locked package's source.
  assert.equal(doc.unappliedProfiles, undefined);
  assert.equal(doc.unappliedTemplates, undefined);
  // missingHostRequirements: structured plan + consent command, no shell text
  const req = doc.missingHostRequirements.find((x) => x.command === "json-doctor-missing-cmd");
  assert.ok(req, JSON.stringify(doc.missingHostRequirements));
  assert.deepEqual(req.plan.argv, ["brew", "install", "json-doctor-missing-cmd"]);
  assert.equal(req.consentCommand, `oas install --accept-requirement json-doctor-missing-cmd --dir ${ws}`);
  assert.deepEqual(req.requestedBy.map((x) => x.capability), ["example.review"]);
  // field parity: every WS2 fact in the human report is present in JSON
  const human = cli(["doctor", ws], { cwd: ws });
  assert.match(human.stdout, /other\.pkg/);
  assert.match(human.stdout, /example\.engineering:default/);
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
  // ONE shape for every plan: `steps` is the ordered sequence that will run and
  // is always present; `argv` is its final command. A single-step plan carries a
  // one-element `steps` rather than omitting it, so JSON clients never branch
  // (reviewer-final0130bc8).
  assert.deepEqual(q1.plan, { manager: "npm-global", argv: ["npm", "install", "-g", "wanted-cli@1.0.0"], steps: [["npm", "install", "-g", "wanted-cli@1.0.0"]], source: "npm registry (wanted-cli@1.0.0)", version: "1.0.0", scope: "user-level (npm global prefix)" });
  assert.deepEqual(q1.requestedBy.map((x) => x.capability), ["needy.cap"]);
  // skipped: --no-requirements
  const r2 = cli(["install", "--json", "--no-requirements", "--dir", w1], { cwd: w1, env });
  const e2 = JSON.parse(r2.stdout);
  assert.equal(e2.result.requirements[0].outcome, "skipped");
  assert.deepEqual(e2.result.requirements[0].plan.steps, [["npm", "install", "-g", "wanted-cli@1.0.0"]],
    "a skipped requirement still shows what WOULD run, in full");
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

test("init --package --json: one envelope with adoption + lock provenance, stable error codes, no prompts", () => {
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
  assert.equal(env.result.template, "default");
  assert.equal(env.result.adopted, true);
  assert.match(env.result.contentIntegrity, /^sha256-[0-9a-f]{64}$/);
  assert.equal(env.result.adoptedBase, join(ws, ".agents/config-templates/adopted/example.engineering/default/oas-config.yaml"));
  assert.equal(env.result.adoptionMetadata, join(ws, ".agents/config-templates/adopted/example.engineering/default/adoption.json"));
  assert.equal(env.result.file, join(ws, "oas-config.yaml"));
  assert.deepEqual(env.result.capabilities, ["example.review", "example.delivery"]);
  assert.equal(env.result.lockFile, join(ws, "oas-lock.json"));
  assert.deepEqual(env.result.lockedPackages, ["example.engineering"]);
  assert.ok(existsSync(join(ws, "oas-config.yaml")));

  // E_CONFIG_EXISTS on overwrite
  const r2 = cli(["init", "--package", pkg, "--json", "--dir", ws]);
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stdout).error.code, "E_CONFIG_EXISTS");

  // E_TEMPLATE_AMBIGUOUS: multiple unmarked templates, no --config
  const multi = fixturePackage(join(base, "multi"), { id: "multi.pkg", configs: {
    a: { path: "configs/default/oas-config.yaml" }, b: { path: "configs/minimal/oas-config.yaml" },
  } });
  const w2 = join(base, "w2"); mkdirSync(w2);
  const r3 = cli(["init", "--package", multi, "--json", "--dir", w2]);
  assert.equal(JSON.parse(r3.stdout).error.code, "E_TEMPLATE_AMBIGUOUS");
  // E_TEMPLATE_NOT_FOUND: explicit unknown template
  const r4 = cli(["init", "--package", multi, "--config", "nope", "--json", "--dir", w2]);
  assert.equal(JSON.parse(r4.stdout).error.code, "E_TEMPLATE_NOT_FOUND");
  // E_TEMPLATE_INVALID: unsupplied capability (fresh scope + distinct capability ids —
  // acquisition is real now, so same-scope duplicate capability exports would collide)
  const bad = fixturePackage(join(base, "bad"), { id: "bad.pkg",
    capabilities: { "capabilities/bad-cap": { capability: "bad.cap", version: "1.0.0", description: "x" } },
    extraFiles: {
      "configs/x/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    ghost.cap:\n      from: installed\n      global: true\n",
    }, configs: { x: { path: "configs/x/oas-config.yaml", default: true } } });
  const w3 = join(base, "w3"); mkdirSync(w3);
  const r5 = cli(["init", "--package", bad, "--json", "--dir", w3]);
  assert.equal(JSON.parse(r5.stdout).error.code, "E_TEMPLATE_INVALID");
  // engine code pass-through: broken manifest fails without writing a config
  // (engine gap a is fixed: JSON null manifests carry invalid-package-manifest)
  const broken = join(base, "broken");
  write(join(broken, "oas-package.json"), "null");
  const w4 = join(base, "w4"); mkdirSync(w4);
  const r6 = cli(["init", "--package", broken, "--json", "--dir", w4]);
  assert.equal(r6.status, 1);
  assert.equal(JSON.parse(r6.stdout).error.code, "invalid-package-manifest");
  assert.equal(existsSync(join(w4, "oas-config.yaml")), false, "no failure path may write a config");
});

test("config diff --json: one envelope with the three-way plan; no drift is a clean plan at exit 0", () => {
  const base = temp();
  const pkg = fixturePackage(join(base, "pkg"));
  const ws = join(base, "ws"); mkdirSync(ws);
  assert.equal(cli(["init", "--package", pkg, "--dir", ws, "--no-tmux-mouse", "--json"]).status, 0);
  const file = join(ws, "oas-config.yaml");

  // Freshly adopted: a clean plan with no regions, exit 0.
  const clean = cli(["config", "diff", "--dir", ws, "--json"]);
  assert.equal(clean.status, 0, clean.stderr);
  const cleanPayload = JSON.parse(clean.stdout);
  assert.equal(cleanPayload.schemaVersion, 1);
  assert.equal(cleanPayload.ok, true);
  assert.equal(cleanPayload.result.clean, true);
  assert.deepEqual(cleanPayload.result.regions, []);
  assert.deepEqual(cleanPayload.result.counts, { upstream: 0, local: 0, conflict: 0, agreed: 0 });
  assert.match(cleanPayload.result.contentIntegrity, /^sha256-[0-9a-f]{64}$/);

  // A local edit becomes a local-only region carrying its own decision metadata.
  writeFileSync(file, `${readFileSync(file, "utf8")}\n# local note\n`);
  const drift = cli(["config", "diff", "--dir", ws, "--json"]);
  assert.equal(drift.status, 0, drift.stderr);
  const region = JSON.parse(drift.stdout).result.regions[0];
  assert.equal(region.kind, "local");
  assert.equal(region.recommended, "local");
  assert.match(region.digest, /^sha256-[0-9a-f]{64}$/);
  assert.ok(region.startLine >= 1);
  assert.match(region.local, /# local note/);

  // Failures are the same single envelope on stdout.
  const bare = join(base, "bare"); mkdirSync(bare);
  const noConfig = cli(["config", "diff", "--dir", bare, "--json"]);
  assert.equal(noConfig.status, 1);
  assert.equal(noConfig.stdout.trimEnd().split("\n").length, 1, "exactly one envelope");
  assert.equal(JSON.parse(noConfig.stdout).error.code, "E_NO_CONFIG");

  rmSync(base, { recursive: true, force: true });
});

test("init --package on a configless scope sees same-lock dependency capabilities in the closure", () => {
  const base = temp();
  // Dependency whose package ID does NOT match its directory basename —
  // reviewer-455ba15 fix 2: closure resolution must come from the acquired
  // root's lock entry (identity-valued dependencies), never from
  // reverse-engineering source strings.
  const dep = fixturePackage(join(base, "some-repo-dir"), {
    id: "dep.pkg",
    capabilities: { "capabilities/dep-cap": { capability: "dep.cap", version: "1.0.0", description: "x" } },
    configs: {},
  });
  // root package whose profile references a capability supplied ONLY by a
  // dependency, declared as a PACKAGE-ROOT-RELATIVE path (engine gap b fixed:
  // relative dependency paths resolve against the depending package's root).
  const root = fixturePackage(join(base, "root"), {
    id: "root.pkg",
    capabilities: { "capabilities/root-cap": { capability: "root.cap", version: "1.0.0", description: "x" } },
    dependencies: ["../some-repo-dir"],
    extraFiles: { "configs/d/oas-config.yaml": "name: w\ncapabilities:\n  additive:\n    dep.cap:\n      from: installed\n      global: true\n" },
    configs: { d: { path: "configs/d/oas-config.yaml", default: true } },
  });
  // configless scope: ONLY an oas-lock.json carrying root + dependency
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  installFixturePackage(ws, root); // engine acquire resolves the dependency into the same closure/lock
  const r = cli(["init", "--package", "root.pkg", "--json", "--dir", ws]);
  assert.equal(r.status, 0, r.stdout);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal(env.result.package, "root.pkg");
  assert.deepEqual(env.result.lockedPackages.sort(), ["dep.pkg", "root.pkg"]);
});

test("init --package always acquires local sources: a same-ID lock from a different source cannot bypass acquisition", () => {
  const base = temp();
  // v1 of the package, adopted normally.
  const v1 = fixturePackage(join(base, "v1"), { id: "same.pkg", configs: { d: { path: "configs/default/oas-config.yaml", default: true } } });
  const ws = join(base, "ws"); mkdirSync(ws, { recursive: true });
  assert.equal(cli(["init", "--package", v1, "--json", "--dir", ws]).status, 0);
  // Remove only the generated config; lock + installed artifact remain at v1 content.
  rmSync(join(ws, "oas-config.yaml"));
  // v2 of the package at a DIFFERENT source path with different content.
  const v2 = fixturePackage(join(base, "v2"), { id: "same.pkg", configs: { d: { path: "configs/default/oas-config.yaml", default: true } }, extraFiles: { "EXTRA.md": "v2 content\n" } });
  const r = cli(["init", "--package", v2, "--json", "--dir", ws]);
  // FIXED engine behavior (7b2cd36, corrective item 5). The contract sentence
  // (agreed dev-to-dev with WS1): "an existing same-scope lock is the
  // invariant — neither a drifted source nor a drifted/missing artifact may
  // silently re-lock without oas update." Re-acquisition against an existing
  // same-scope lock with different resolved integrity is integrity-drift with
  // the oas update pointer — never re-legitimized. (The CLI surfaces kernel
  // codes AS the envelope code: error.code === "integrity-drift", no E_ wrapper.)
  assert.equal(r.status, 1, `same-ID different-source init must not bypass acquisition:\n${r.stdout}`);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "integrity-drift");
  assert.match(env.error.message, /locked source never advances on acquire.*oas update/s);
  assert.equal(existsSync(join(ws, "oas-config.yaml")), false, "no snapshot published on refused acquisition");
  // lock unchanged by the refused acquisition
  const lockAfter = JSON.parse(readFileSync(join(ws, "oas-lock.json"), "utf8")).packages["same.pkg"];
  assert.notEqual(lockAfter.integrity, undefined);
  // Identical re-init (same source) still works — exact-integrity reuse is a no-op re-lock.
  const again = cli(["init", "--package", v1, "--json", "--dir", ws]);
  assert.equal(again.status, 0, again.stdout);
});

test("an explicit command: null requirement is malformed, not absent — fail-closed policy applies", () => {
  const base = temp();
  const ws = join(base, "ws");
  write(join(ws, ".agents", "capabilities", "owned", "nully", "oas.json"), JSON.stringify({
    capability: "nully.cap", version: "1.0.0", description: "x",
    requires: [{ command: null, why: "null command" }],
  }));
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    nully.cap:\n      from: owned\n      global: true\n");
  const missing = aggregateMissingRequirements([ws]);
  assert.equal(missing.length, 1, JSON.stringify(missing));
  assert.ok(missing[0].invalid, "null command is a typed invalid record");
  const r = cli(["install", "--json", "--no-requirements", "--dir", ws], { cwd: ws });
  assert.equal(r.status, 1, r.stdout);
  const env = JSON.parse(r.stdout);
  assert.equal(env.error.code, "E_RECONCILE_FAILED");
  assert.equal(env.error.details.requirements[0].code, "E_REQUIREMENT_POLICY");
});

test("configless-scope provider shadowing: own-scope acquired manifests override an outer same-identity package", () => {
  const base = temp();
  // OUTER scope: dep.pkg exporting dep.cap with layer KNOWLEDGE.
  const outer = join(base, "outer");
  write(join(outer, "oas-config.yaml"), "name: outer\n");
  const outerSrc = fixturePackage(join(base, "outer-src"), {
    id: "dep.pkg",
    capabilities: { "capabilities/dep": { capability: "dep.cap", version: "1.0.0", description: "x", layer: "knowledge", compatibility: { oas: ">=0.6.2" } } },
    configs: {},
  });
  installFixturePackage(outer, outerSrc);
  // INNER configless scope: freshly acquired dep.pkg whose dep.cap declares MESSAGING,
  // plus a root package binding dep.cap to knowledge in its profile.
  const innerDepSrc = fixturePackage(join(base, "inner-dep-src"), {
    id: "dep.pkg",
    capabilities: { "capabilities/dep": { capability: "dep.cap", version: "2.0.0", description: "x", layer: "messaging", compatibility: { oas: ">=0.6.2" } } },
    configs: {},
  });
  const rootSrc = fixturePackage(join(base, "root-src"), {
    id: "root.pkg",
    capabilities: { "capabilities/root": { capability: "root.cap", version: "1.0.0", description: "x", compatibility: { oas: ">=0.6.2" } } },
    dependencies: ["../inner-dep-src"],
    extraFiles: { "configs/k/oas-config.yaml": "name: w\ncapabilities:\n  layers:\n    knowledge:\n      capability: dep.cap\n      from: installed\n" },
    configs: { k: { path: "configs/k/oas-config.yaml", default: true } },
  });
  const ws = join(outer, "member"); mkdirSync(ws, { recursive: true });
  // Pre-fix: listInstalledPackages returned the OUTER dep.pkg (knowledge) and the
  // byId.has() guard skipped the inner artifact — the invalid knowledge binding
  // snapshotted, then config resolution failed on the written file.
  const r = cli(["init", "--package", rootSrc, "--json", "--dir", ws]);
  assert.equal(r.status, 1, `inner provider's layer (messaging) must govern:\n${r.stdout}`);
  const env = JSON.parse(r.stdout);
  assert.equal(env.error.code, "E_PROFILE_INVALID");
  assert.match(env.error.message, /layer knowledge binds dep\.cap, but its manifest declares layer "messaging"/);
  assert.equal(existsSync(join(ws, "oas-config.yaml")), false, "no invalid snapshot written");
});

test("catalog source grammar: short-id inputs accepted, catalog: prefix is lock-normalized output only (reviewer-78f72e5)", () => {
  const bare = parsePackageSource("example.engineering");
  assert.equal(bare.kind, "catalog");
  assert.equal(bare.id, "example.engineering");
  assert.equal(bare.normalized, "catalog:example.engineering");
  const pinned = parsePackageSource("example.engineering@1.2.0");
  assert.equal(pinned.selector, "1.2.0");
  assert.equal(pinned.normalized, "catalog:example.engineering@1.2.0");
  // the normalized spelling is NOT accepted as input (docs must show short forms)
  for (const s of ["catalog:example.engineering", "catalog:example.engineering@1.2.0"]) {
    assert.throws(() => parsePackageSource(s), (e) => e.code === "invalid-source", s);
  }
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
    // WS3-coordination point: dependency spec form (package-root-relative
    // local path now — engine gap b fixed; the engine also accepts official
    // catalog SHORT-ID inputs, <id> and <id>@<selector> (the catalog: prefix
    // is the NORMALIZED lock-metadata spelling, not input syntax) — switch
    // this spec to a catalog selector once WS3's published catalog lands).
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

test("oas.dev end-to-end at a NON-GIT multi-repo team root: targeting, overrides, portability, snapshot semantics, nested reconciliation", () => {
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
  // REAL acceptance coverage (gate-2 teardown of the reviewer-d5dadab
  // stand-in): capabilities are discovered THROUGH the installed package
  // roots — the engine's installed-package origin — with no owned-store
  // materialization and the snapshot's `from: installed` untouched.
  // Retarget oas.review from the profile's agent-type binding to global — ordinary `oas use`.
  const useR = cli(["use", "oas.review", "--global", "--dir", ws]);
  assert.equal(useR.status, 0, useR.stderr);
  const wsResolved = resolveOasConfig(ws, undefined);
  assert.ok(wsResolved.capabilities.some((c) => c.id === "oas.review"), "retargeted capability resolves globally");
  assert.equal(wsResolved.layers.knowledge.id, "oasdev.knowledge");

  // (4) Closer child-repo config overrides the workspace assignment.
  const child = join(ws, "member-repo"); mkdirSync(child, { recursive: true });
  write(join(child, "oas-config.yaml"), "name: member\ncapabilities:\n  layers:\n    knowledge: none\n  additive:\n    oas.review:\n      from: installed\n      global: false\n");
  const childResolved = resolveOasConfig(child, undefined);
  assert.equal(childResolved.layers.knowledge, undefined, "child disables the inherited layer");
  assert.equal(childResolved.capabilities.some((c) => c.id === "oas.review"), false, "child excludes the capability");
  assert.ok(resolveOasConfig(ws, undefined).capabilities.some((c) => c.id === "oas.review"), "workspace scope unaffected");

  // (7) Bare install at the team boundary reconciles nested repos.
  // The child repo carries its own lock for an ADDITIONAL package (multi-repo shape).
  const extra = join(base, "src", "extra");
  write(join(extra, "capabilities", "extra", "oas.json"), JSON.stringify({ capability: "oasdev.extra", version: "1.0.0", description: "x" }));
  write(join(extra, "oas-package.json"), JSON.stringify({ package: "oasdev.extra-pkg", version: "1.0.0", description: "Extra member package.", compatibility: { oas: ">=0.6.2" }, capabilities: ["capabilities/extra"] }));
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
  // The installed locked copy has not drifted (snapshots + locks pin exactly);
  // the `oas use` retargeting edit above shows as local drift.
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

// ---------- runtime-package requirements (satisfied by a runtime, not by PATH) ----------

test("packageSpecIdentity collapses version selectors, keeping scoped names intact", () => {
  assert.equal(packageSpecIdentity("npm:@awebai/pi@latest"), "npm:@awebai/pi");
  assert.equal(packageSpecIdentity("npm:@awebai/pi@0.2.1"), "npm:@awebai/pi");
  assert.equal(packageSpecIdentity("npm:@awebai/pi"), "npm:@awebai/pi");
  assert.equal(packageSpecIdentity("npm:pi-web-search@^1.2.0"), "npm:pi-web-search");
});

test("a runtime package counts as installed only when the runtime resolves an install location", () => {
  const base = temp();
  const pkgDir = join(base, "store", "@awebai", "pi");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "@awebai/pi" }));
  const oldPath = process.env.PATH;
  try {
    // Verified: pi lists it AND names a directory that exists.
    process.env.PATH = fakePi(base, [{ source: "npm:@awebai/pi@latest", dir: pkgDir }]);
    const env = { ...process.env, HOME: base };
    assert.equal(runtimePackageInstalled("pi", "npm:@awebai/pi", env), true, "matches across a version selector");
    assert.equal(runtimePackageInstalled("pi", "npm:@awebai/pi@0.2.1", env), true);
    assert.equal(runtimePackageInstalled("pi", "npm:not-installed", env), false);
    assert.equal(runtimePackageInstalled("nosuchruntime", "npm:@awebai/pi", env), false, "unknown runtime is never satisfied");

    // Configured but never installed: pi prints no path line. Presence in the
    // list is not installation.
    process.env.PATH = fakePi(base, [{ source: "npm:@awebai/pi" }]);
    const st = runtimePackageStatus("pi", "npm:@awebai/pi", { ...process.env, HOME: base });
    assert.equal(st.installed, true, "the row exists…");
    assert.equal(st.missingFiles, true, "…but nothing is installed for it");
    assert.equal(runtimePackageInstalled("pi", "npm:@awebai/pi", { ...process.env, HOME: base }), false);

    // pi unrunnable: settings record intent, never installation.
    process.env.PATH = fakePi(base, [], { fails: true });
    write(join(base, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@awebai/pi"] }));
    const fallback = runtimePackageStatus("pi", "npm:@awebai/pi", { ...process.env, HOME: base });
    assert.match(fallback.unverified || "", /could not run/);
    assert.equal(runtimePackageInstalled("pi", "npm:@awebai/pi", { ...process.env, HOME: base }), false,
      "a config entry is never accepted as an installation");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("a runtime-package requirement plans an argv install scoped to its runtime", () => {
  const plan = requirementInstallPlan({
    runtime: "pi", package: "npm:@awebai/pi", why: "aweb channel extension for pi sessions",
  });
  assert.deepEqual(plan.argv, ["pi", "install", "npm:@awebai/pi"], "argv only — no shell, no sudo");
  assert.equal(plan.runtime, "pi");
  assert.equal(plan.command, "pi:npm:@awebai/pi", "identity is runtime-scoped");
  assert.match(plan.scope, /pi packages/);
  // Unknown runtimes and unsafe specs are never given an executable plan.
  assert.match(requirementInstallPlan({ runtime: "nope", package: "npm:x" }).unavailable, /unknown runtime/);
  assert.match(requirementInstallPlan({ runtime: "pi", package: "npm:x; rm -rf /" }).unavailable, /not a plain source token/);
  assert.match(requirementInstallPlan({ runtime: "pi", package: "../../etc/passwd" }).unavailable, /not a plain source token/);
});

test("an unknown runtime in a requirement is fail-closed, never consentable", () => {
  const base = temp();
  const repo = join(base, "repo");
  const capDir = join(repo, ".agents", "capabilities", "owned", "bad");
  write(join(capDir, "oas.json"), JSON.stringify({
    capability: "acme.bad", version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "Bad.",
    requires: [{ runtime: "deno-but-not-real", package: "npm:whatever", why: "nope" }],
  }));
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.bad:\n      global: true\n");
  gitRepo(repo);
  const found = aggregateMissingRequirements([repo], { env: { ...process.env, HOME: temp() } });
  const bad = found.find((m) => m.invalid);
  assert.ok(bad, "invalid requirement is surfaced");
  assert.equal(bad.plan, null, "no executable plan is offered");
  assert.match(bad.invalid, /unknown runtime/);
  rmSync(base, { recursive: true, force: true });
});

test("the aweb capability declares its pi channel package as a requirement", () => {
  // The behavior this whole mechanism exists for: using aweb from pi must
  // require the aweb pi package, instead of silently depending on whatever the
  // user happens to have installed globally.
  const manifest = JSON.parse(readFileSync(resolve(new URL("../capabilities/oas-aweb/oas.json", import.meta.url).pathname), "utf8"));
  const req = (manifest.requires || []).find((r) => r.runtime === "pi");
  assert.ok(req, "oas-aweb declares a pi runtime requirement");
  assert.equal(packageSpecIdentity(req.package), "npm:@awebai/pi");
  assert.ok(req.why && req.why.length > 20, "the prompt tells the user why it is needed");
  const plan = requirementInstallPlan(req);
  assert.deepEqual(plan.argv, ["pi", "install", "npm:@awebai/pi"]);
});

/** A deployment whose souls have the given runtimes, with a pi-requiring capability. */
function runtimeScopeFixture(base, souls, { target = "global" } = {}) {
  const repo = join(base, "repo");
  const capDir = join(repo, ".agents", "capabilities", "owned", "chan");
  write(join(capDir, "oas.json"), JSON.stringify({
    capability: "acme.chan", version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "Channel.",
    requires: [{ runtime: "pi", package: "npm:@awebai/pi@latest", why: "channel extension" }],
  }));
  for (const [name, spec] of Object.entries(souls)) {
    const { runtime, type } = typeof spec === "string" ? { runtime: spec } : spec;
    write(join(repo, "agents", name, "soul", "soul.yaml"),
      `name: ${name}\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: ${runtime}\n${type ? `type: ${type}\n` : ""}`);
    write(join(repo, "agents", name, "soul", "AGENTS.md"), `# ${name}\n`);
  }
  const binding = target === "global" ? "      global: true\n"
    : target.startsWith("type:") ? `      agent-types:\n        ${target.slice(5)}:\n          enabled: true\n`
    : `      souls:\n        ${target.slice(5)}:\n          enabled: true\n`;
  const types = target.startsWith("type:") ? `agent-types:\n  ${target.slice(5)}: {}\n` : "";
  write(join(repo, "oas-config.yaml"), `${types}capabilities:\n  additive:\n    acme.chan:\n${binding}`);
  gitRepo(repo);
  return repo;
}
/** A `pi` stub answering `pi list` in pi's real format: the install path line
 * appears ONLY for a genuinely installed package. Returns a PATH prefix. */
function fakePi(base, rows, { fails = false } = {}) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const body = ["User packages:", ...rows.flatMap((r) => [
    `  ${r.source}${r.filtered ? " (filtered)" : ""}`,
    ...(r.dir ? [`    ${r.dir}`] : []),
  ])].join("\n");
  write(join(bin, "pi"), fails ? "#!/bin/sh\nexit 3\n" : `#!/bin/sh\nif [ "$1" = "list" ]; then cat <<'EOF'\n${body}\nEOF\nfi\nexit 0\n`);
  chmodSync(join(bin, "pi"), 0o755);
  return `${bin}:${process.env.PATH}`;
}

const noPiPackages = () => ({ ...process.env, HOME: mkdtempSync(join(tmpdir(), "oas-nopi-")) });

test("a Claude-only deployment is never prompted for a pi package", () => {
  const base = temp();
  const repo = runtimeScopeFixture(base, { writer: "claude", editor: "claude" });
  const missing = aggregateMissingRequirements([repo], { env: noPiPackages() });
  assert.equal(missing.some((m) => m.kind === "runtime-package"), false,
    `no pi requirement for a Claude-only host: ${JSON.stringify(missing.map((m) => m.command))}`);
  rmSync(base, { recursive: true, force: true });
});

test("a pi deployment is prompted, with soul-level provenance", () => {
  const base = temp();
  const repo = runtimeScopeFixture(base, { coder: "pi" });
  const missing = aggregateMissingRequirements([repo], { env: noPiPackages() });
  const req = missing.find((m) => m.command === "pi:npm:@awebai/pi");
  assert.ok(req, "the pi requirement is raised");
  assert.deepEqual(req.plan.argv, ["pi", "install", "npm:@awebai/pi@latest"]);
  assert.deepEqual(req.requestedBy[0].souls, ["coder"], "provenance names the soul that pulled it in");
  rmSync(base, { recursive: true, force: true });
});

test("a mixed pi+claude deployment reports ONE deduped requirement naming only the pi souls", () => {
  const base = temp();
  const repo = runtimeScopeFixture(base, { coder: "pi", helper: "pi", reviewer: "claude" });
  const missing = aggregateMissingRequirements([repo], { env: noPiPackages() });
  const reqs = missing.filter((m) => m.kind === "runtime-package");
  assert.equal(reqs.length, 1, "deduped to one requirement");
  assert.deepEqual(reqs[0].requestedBy[0].souls.sort(), ["coder", "helper"], "claude souls are not listed as requesters");
  rmSync(base, { recursive: true, force: true });
});

test("type and soul targeting scope the requirement to the souls actually targeted", () => {
  const base = temp();
  // Only the pi soul carries the targeted type.
  const byType = runtimeScopeFixture(join(base, "a"),
    { coder: { runtime: "pi", type: "developers" }, reviewer: "claude" }, { target: "type:developers" });
  assert.ok(aggregateMissingRequirements([byType], { env: noPiPackages() }).some((m) => m.kind === "runtime-package"),
    "raised when the targeted type is a pi soul");

  // The targeted type belongs only to a claude soul → never raised.
  const claudeType = runtimeScopeFixture(join(base, "b"),
    { coder: "pi", reviewer: { runtime: "claude", type: "reviewers" } }, { target: "type:reviewers" });
  assert.equal(aggregateMissingRequirements([claudeType], { env: noPiPackages() }).some((m) => m.kind === "runtime-package"), false,
    "not raised when the targeted type is claude-only");

  // Explicit soul targeting, claude soul only.
  const bySoul = runtimeScopeFixture(join(base, "c"), { coder: "pi", reviewer: "claude" }, { target: "soul:reviewer" });
  assert.equal(aggregateMissingRequirements([bySoul], { env: noPiPackages() }).some((m) => m.kind === "runtime-package"), false,
    "not raised when only a claude soul is targeted");
  rmSync(base, { recursive: true, force: true });
});

test("no souls yet: the requirement is not raised, and the policy is spawn's to enforce", () => {
  const base = temp();
  const repo = runtimeScopeFixture(base, {});   // capability active, zero souls
  const targets = capabilityRuntimeTargets(repo, "acme.chan");
  assert.equal(targets.souls, 0);
  assert.equal(targets.runtimes.size, 0);
  assert.equal(aggregateMissingRequirements([repo], { env: noPiPackages() }).some((m) => m.kind === "runtime-package"), false,
    "a fresh deployment is not prompted for runtimes its future souls may never use");
  rmSync(base, { recursive: true, force: true });
});

test("a genuinely installed pi package is not raised; an unverifiable one still is (reviewer-14c38e8)", () => {
  const base = temp();
  const repo = runtimeScopeFixture(base, { coder: "pi" });
  const pkgDir = join(base, "store", "@awebai", "pi");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "@awebai/pi" }));
  const oldPath = process.env.PATH;
  try {
    // Verified install → nothing to prompt for.
    process.env.PATH = fakePi(base, [{ source: "npm:@awebai/pi@0.2.1", dir: pkgDir }]);
    assert.equal(aggregateMissingRequirements([repo], { env: { ...process.env, HOME: temp() } }).some((m) => m.kind === "runtime-package"), false);

    // Listed with NO install location: aggregation must still offer to install
    // it, or the `oas install --accept-requirement …` remedy spawn prints is a
    // no-op and the retry fails identically.
    process.env.PATH = fakePi(base, [{ source: "npm:@awebai/pi" }]);
    assert.ok(aggregateMissingRequirements([repo], { env: { ...process.env, HOME: temp() } }).some((m) => m.command === "pi:npm:@awebai/pi"),
      "a configured-but-uninstalled package is still raised");

    // `pi list` fails and only settings exist: same conclusion.
    const home = temp();
    write(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@awebai/pi"] }));
    process.env.PATH = fakePi(base, [], { fails: true });
    assert.ok(aggregateMissingRequirements([repo], { env: { ...process.env, HOME: home } }).some((m) => m.command === "pi:npm:@awebai/pi"),
      "an unverifiable settings row is still raised");
    rmSync(home, { recursive: true, force: true });
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("naming a requirement with --accept-requirement overrides runtime scoping (reviewer-ad1b9f0)", () => {
  const base = temp();
  // Claude-only souls: scoping correctly hides the pi requirement by default…
  const repo = runtimeScopeFixture(base, { reviewer: "claude" });
  const env = noPiPackages();
  assert.equal(aggregateMissingRequirements([repo], { env }).some((m) => m.kind === "runtime-package"), false,
    "not raised unprompted on a Claude-only host");
  // …but `--runtime pi` at spawn emits `oas install --accept-requirement pi:…`,
  // and that command must actually have something to install, or the remedy we
  // printed is a no-op and the retry fails identically.
  const named = aggregateMissingRequirements([repo], { env, accepted: new Set(["pi:npm:@awebai/pi"]) });
  const req = named.find((m) => m.command === "pi:npm:@awebai/pi");
  assert.ok(req, "explicitly naming the requirement surfaces it for install");
  assert.deepEqual(req.plan.argv, ["pi", "install", "npm:@awebai/pi@latest"]);
  rmSync(base, { recursive: true, force: true });
});

test("same plugin from DIFFERENT marketplace sources is a conflict, not a silent merge (reviewer-6f1bb9c)", () => {
  const base = temp();
  const repo = join(base, "repo");
  // Two capabilities want the same plugin id but register its marketplace from
  // different sources. Keying conflicts on the final argv alone collapses these
  // into one requirement and whichever was seen first silently wins — including
  // which third-party source gets registered on the operator's machine.
  for (const [folder, id, marketplace] of [["a", "acme.a", "acme/claude-plugins"], ["b", "acme.b", "impostor/claude-plugins"]]) {
    write(join(repo, ".agents", "capabilities", "owned", folder, "oas.json"), JSON.stringify({
      capability: id, version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "x",
      requires: [{ runtime: "claude", package: "chan@acme-marketplace", marketplace, why: "push events" }],
    }));
  }
  write(join(repo, "agents", "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: claude\n`);
  write(join(repo, "agents", "dev", "soul", "AGENTS.md"), "# dev\n");
  write(join(repo, "oas-config.yaml"),
    "capabilities:\n  additive:\n    acme.a:\n      global: true\n    acme.b:\n      global: true\n");
  gitRepo(repo);
  const found = aggregateMissingRequirements([repo], { env: { ...process.env, HOME: temp() } });
  const req = found.find((m) => String(m.command).startsWith("claude:"));
  assert.ok(req, `the requirement is surfaced: ${JSON.stringify(found.map((f) => f.command))}`);
  assert.ok(req.conflict, "differing marketplace sources must conflict");
  assert.equal(req.plan, null, "and no install is offered");
  assert.equal(req.conflict.plans.length, 2, "both requesters are named for provenance");
  rmSync(base, { recursive: true, force: true });
});

test("post-install verification probes the same executable the install ran through (reviewer-165d668)", () => {
  const base = temp();
  // Two wrappers reporting OPPOSITE states: `claude-personal` (the configured
  // one) has the plugin, the literal `claude` does not.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // The advertised installPath must EXIST — Claude names one, and a row pointing
  // at a directory that was never created is a registration without an install,
  // which the preflight is supposed to reject (reviewer-aggregate2).
  const listing = (rows) => JSON.stringify(rows.map((id) => {
    mkdirSync(join(base, id), { recursive: true });
    return { id, version: "1.0.0", scope: "user", enabled: true, installPath: join(base, id) };
  }));
  for (const [name, rows] of [["claude", []], ["claude-personal", ["chan@acme-marketplace"]]]) {
    write(join(bin, name), `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then echo '${listing(rows)}'; exit 0; fi
exit 0
`);
  }
  execFileSync("chmod", ["-R", "+x", bin]);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    const repo = join(base, "repo");
    write(join(repo, "oas-claude-config"), "claude-personal\n");
    const plan = requirementInstallPlan(
      { runtime: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" },
      { context: repo },
    );
    // The plan targets the configured wrapper…
    assert.equal(plan.steps[0][0], "claude-personal");
    assert.equal(plan.probe?.bin, "claude-personal", "…and carries it for verification");
    // …so the install verifies against that wrapper, which HAS the plugin.
    // Probing the literal `claude` here would report a successful install failed.
    const r = runRequirementInstall(plan, { stdio: "ignore" });
    assert.equal(r.onPath, true, "verified through the executable the install used");
  } finally { process.env.PATH = oldPath; }
  rmSync(base, { recursive: true, force: true });
});

test("the JSON consent plan shows every step the installer will run (reviewer-final0130bc8)", () => {
  const base = temp();
  const ws = join(base, "ws");
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // A Claude runtime package needs its MARKETPLACE registered before install —
  // two commands, the first of which registers a lower-trust source. Serializing
  // only the final argv meant a client consenting through the JSON API never saw
  // that step, while runRequirementInstall ran it.
  write(join(bin, "claude"), "#!/bin/sh\nif [ \"$1\" = \"plugin\" ] && [ \"$2\" = \"list\" ]; then echo '[]'; exit 0; fi\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  write(join(bin, "pi"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "pi"), 0o755);
  write(join(ws, "agents", "dev", "soul", "soul.yaml"), "name: dev\nkind: persistent\nruntime: claude\n");
  write(join(ws, "agents", "dev", "soul", "AGENTS.md"), "# dev\n");
  write(join(ws, ".agents", "capabilities", "owned", "chan", "oas.json"), JSON.stringify({
    capability: "acme.chan", version: "1.0.0", description: "x",
    requires: [{ runtime: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  }));
  write(join(ws, "oas-config.yaml"), "name: ws\nteam:\n  name: t\ncapabilities:\n  additive:\n    acme.chan:\n      from: owned\n      global: true\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  const human = cli(["install", "--dir", ws], { cwd: ws, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /claude plugin marketplace add acme\/claude-plugins/,
    "the human plan names the source registration");

  const r = cli(["install", "--json", "--dir", ws], { cwd: ws, env });
  const env1 = JSON.parse(r.stdout);
  assert.equal(env1.schemaVersion, 1);
  const entry = (env1.result.requirements || []).find((e) => e.package === "chan@acme-marketplace");
  assert.ok(entry, `the requirement is reported in JSON: ${r.stdout}`);
  // PARITY: the ordered sequence the installer executes, not just its last command.
  assert.deepEqual(entry.plan.steps, [
    ["claude", "plugin", "marketplace", "add", "acme/claude-plugins"],
    ["claude", "plugin", "install", "chan@acme-marketplace"],
  ], "the JSON plan carries every step, in order");
  assert.deepEqual(entry.plan.argv, entry.plan.steps.at(-1), "argv stays the final command");
  // What the installer would actually run must equal what was shown.
  const plan = requirementInstallPlan(
    { runtime: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" },
    { context: ws },
  );
  assert.deepEqual(entry.plan.steps, plan.steps, "the consented sequence IS the executed sequence");

  // Single-step plans keep one shape: `steps` present, holding just that argv.
  write(join(ws, ".agents", "capabilities", "owned", "chan", "oas.json"), JSON.stringify({
    capability: "acme.chan", version: "1.0.0", description: "x",
    requires: [{ command: "wanted-cli", why: "testing", install: { docs: "https://example.invalid", methods: [{ platform: process.platform, manager: "npm-global", package: "wanted-cli@1.0.0" }] } }],
  }));
  const single = JSON.parse(cli(["install", "--json", "--dir", ws], { cwd: ws, env }).stdout);
  const one = (single.result.requirements || []).find((e) => e.command === "wanted-cli");
  assert.ok(one, "single-step requirement reported");
  assert.deepEqual(one.plan.steps, [one.plan.argv], "a single-step plan still carries steps, holding exactly its argv");
  rmSync(base, { recursive: true, force: true });
});

test("resolveProfilePackage selects the same contained package root acquisition would lock", () => {
  const base = temp();
  const repo = join(base, "repo");
  fixturePackage(join(repo, "oas-package"));
  fixturePackage(join(repo, "dist"), { id: "example.other" });
  // A DIFFERENT package at the repository root must never be what a profile
  // diff reads when the source selects a contained root.
  fixturePackage(repo, { id: "example.rootdecoy" });
  gitRepo(repo);

  const clone = () => mkdtempSync(join(tmpdir(), "oas-clone-"));
  const dflt = resolveProfilePackage(`file://${repo}`, base, { clone: clone() });
  assert.equal(dflt.manifest.package, "example.engineering", "no fragment selects oas-package/");
  assert.equal(dflt.source, `git:file://${repo}`, "the recorded source never carries the fragment");
  assert.equal(resolveProfilePackage(`file://${repo}#dist`, base, { clone: clone() }).manifest.package, "example.other");
  assert.equal(resolveProfilePackage(`file://${repo}#.`, base, { clone: clone() }).manifest.package, "example.rootdecoy");
  assert.throws(() => resolveProfilePackage(`file://${repo}#nope`, base, { clone: clone() }), (e) => e.code === "invalid-source");
  assert.throws(() => resolveProfilePackage(`file://${repo}#../escape`, base, { clone: clone() }), (e) => e.code === "path-escape");

  // Local paths stay exact directories.
  assert.equal(resolveProfilePackage(join(repo, "dist"), base).manifest.package, "example.other");
  rmSync(base, { recursive: true, force: true });
});

test("resolveProfilePackage reads the profile at the PINNED ref, not HEAD (reviewer-da05e73)", () => {
  const base = temp();
  const repo = join(base, "repo");
  fixturePackage(join(repo, "oas-package"));
  gitRepo(repo);
  execFileSync("git", ["-C", repo, "tag", "v1"]);
  const pinned = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // HEAD moves on: a diff that reads HEAD while claiming "@v1" compares the
  // adopted snapshot against a profile the install never used.
  write(join(repo, "oas-package", "configs/minimal/oas-config.yaml"), "name: workspace\n# CHANGED AFTER v1\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "advance"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.notEqual(head, pinned);

  const clone = () => mkdtempSync(join(tmpdir(), "oas-clone-"));
  for (const ref of ["v1", pinned]) {
    const r = resolveProfilePackage(`file://${repo}@${ref}`, base, { clone: clone() });
    assert.equal(r.commit, pinned, `${ref}: resolved commit is the pinned one`);
    assert.doesNotMatch(readProfileText(r.manifest, selectProfile(r.manifest, "minimal")), /CHANGED AFTER v1/, `${ref}: profile text comes from the pinned ref`);
    assert.equal(r.source, `git:file://${repo}@${ref}`);
  }
  const unpinned = resolveProfilePackage(`file://${repo}`, base, { clone: clone() });
  assert.equal(unpinned.commit, head, "an unpinned source still resolves HEAD");
  rmSync(base, { recursive: true, force: true });
});

test("resolveProfilePackage rejects an option-like ref instead of reading HEAD (reviewer-39c11e1)", () => {
  const base = temp();
  const repo = join(base, "repo");
  fixturePackage(join(repo, "oas-package"));
  gitRepo(repo);
  const clone = () => mkdtempSync(join(tmpdir(), "oas-clone-"));
  for (const ref of ["--detach", "--guess", "no-such-tag"]) {
    assert.throws(() => resolveProfilePackage(`file://${repo}@${ref}`, base, { clone: clone() }),
      (e) => e.code === "invalid-source" && /does not resolve to a commit/.test(e.message), ref);
  }
  rmSync(base, { recursive: true, force: true });
});
