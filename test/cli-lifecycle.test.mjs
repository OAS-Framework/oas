// CLI lifecycle surface over capability materialization.
//
// These cases were removed from test/package-engine.test.mjs when the engine
// suite was narrowed to the engine API. They drive the CLI, so they live here.
// They are TRANSLATED, not copied: the package store and the residue subsystem
// are gone, so assertions about `.agents/packages/`, package-row capability
// lists, `depsIntegrity` and migration residue are restated against flat
// capability artifacts, capability-row provenance and the all-or-nothing
// migration contract.
//
// What this file is for, in one line each:
//   - the agent-callable JSON boundary: exactly one stdout envelope, always;
//   - fail-closed lock diagnosis: a lock the reader refuses is never served as
//     usable-but-empty, on any command;
//   - canonical dispatch: the CLI a capability command runs is the one that
//     dispatched it, never whatever PATH happens to resolve.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { OAS_LOCK_FILE, capabilityIntegrity, findAgent, installedCapabilitiesDir, writeCapabilityLock } from "../lib/core.mjs";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
const temp = () => mkdtempSync(join(tmpdir(), "oas-cli-lifecycle-"));
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }

function gitify(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init", "--allow-empty"]);
  return dir;
}

/** Run the CLI. `catalog` binds a fixture catalog; `null` binds an EMPTY one so
 * no case can silently reach the real one — or the network. */
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), "oas-cli-lifecycle-home-"));
function cli(argv, { catalog, cwd, env: extra } = {}) {
  // Hermetic environment. Two distinct leaks have to be closed, and neither is
  // hypothetical — both were observed:
  //   - HOME: the config/lock walk climbs to `/` and unions the laptop level,
  //     so a developer's own ~/oas-config.yaml or ~/oas-lock.json would decide
  //     what a test sees.
  //   - OAS_HOME / PI_AGENT_HOME (and every other OAS_*/PI_* variable): when
  //     the suite runs inside an OAS instance, the command dispatcher finds
  //     that instance's `instance.json` and re-points its whole context at the
  //     REAL repository instead of the fixture scope.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OAS|PI)_/.test(k)) env[k] = v;
  Object.assign(env, { HOME: HERMETIC_HOME, OAS_HOME_DIR: join(HERMETIC_HOME, ".oas") }, extra);
  if (catalog) env.OAS_PACKAGE_CATALOG = catalog;
  else delete env.OAS_PACKAGE_CATALOG;
  return spawnSync(process.execPath, [CLI, ...argv], { cwd: cwd || tmpdir(), env, encoding: "utf8" });
}

/** Assert stdout is EXACTLY one schema-v1 envelope and return it. This is the
 * agent-callable contract: a second document, or a stray log line, breaks every
 * machine consumer. */
function envelope(r) {
  const doc = JSON.parse(r.stdout);
  assert.equal(r.stdout.trim(), JSON.stringify(doc), "stdout is exactly one JSON document");
  assert.equal(doc.schemaVersion, 1);
  return doc;
}
const okEnvelope = (r) => { const d = envelope(r); assert.equal(d.ok, true, JSON.stringify(d)); return d.result; };
const failEnvelope = (r, code) => {
  const d = envelope(r);
  assert.equal(d.ok, false, JSON.stringify(d));
  if (code) assert.equal(d.error.code, code, d.error.message);
  return d.error;
};

/** Content hash of every file under a tree — the byte-identical oracle. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** A package source exporting the given capabilities. `commands` values are
 * "<script> [args…]" STRINGS — the object form stringifies to [object Object]
 * and fails the engine's self-containment check. */
function pkgSource(dir, pkgId, capabilities, extra = {}) {
  const rels = [];
  for (const [rel, cm] of Object.entries(capabilities)) {
    rels.push(rel);
    for (const [file, body] of Object.entries(cm._files || {})) write(join(dir, rel, file), body);
    const { _files, ...manifest } = cm;
    write(join(dir, rel, "oas.json"), JSON.stringify({ version: "1.0.0", description: "cap", ...manifest }, null, 2));
  }
  write(join(dir, "oas-package.json"), JSON.stringify({
    package: pkgId, version: "1.0.0", description: `package ${pkgId}`,
    compatibility: { oas: ">=0.1.0" }, capabilities: rels, ...extra,
  }, null, 2));
  return dir;
}

/** The everyday fixture: one package, one plain capability, one executable. */
function fixture(base) {
  return pkgSource(join(base, "src"), "x.p", {
    "capabilities/plain": { capability: "x.plain" },
    "capabilities/exec": { capability: "x.exec", commands: { go: "bin/go.mjs run" }, hooks: { spawn: "bin/hook.mjs" }, _files: { "bin/go.mjs": "//\n", "bin/hook.mjs": "//\n" } },
  });
}

const lockOf = (dir) => JSON.parse(readFileSync(join(dir, OAS_LOCK_FILE), "utf8"));
const artifact = (dir, id) => join(dir, ".agents", "capabilities", "installed", id);

/** A scope with a config, so the config chain reaches it. */
function scope(base, name = "scope", config = "name: t\n") {
  const dir = join(base, name);
  write(join(dir, "oas-config.yaml"), config);
  return dir;
}

// ---------- the agent-callable JSON boundary ----------

test("install JSON branches: package success, already-present restore, and a typed failure all emit ONE envelope", () => {
  const base = temp();
  const src = fixture(base);
  const s = scope(base);

  // (a) success: the capability rows are the payload, not a package-shaped summary.
  const first = cli(["install", src, "--dir", s, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const installed = okEnvelope(first);
  assert.equal(installed.root, "x.p");
  assert.deepEqual(installed.capabilities.map((c) => c.capability).sort(), ["x.exec", "x.plain"]);
  assert.ok(installed.capabilities.every((c) => c.trusted === false), "acquisition trusts nothing");

  // (b) bare restore of an intact scope: everything present, nothing re-fetched.
  const restore = cli(["install", "--no-requirements", "--dir", s, "--json"], { cwd: s });
  assert.equal(restore.status, 0, restore.stdout);
  const rows = okEnvelope(restore).scopes.flatMap((x) => x.artifacts);
  const pkgRows = rows.filter((a) => a.id === "x.p");
  assert.ok(pkgRows.length, JSON.stringify(rows));
  assert.ok(pkgRows.every((a) => a.status === "present"), JSON.stringify(pkgRows));

  // (c) failure: a source that is not a package, typed and single-enveloped.
  const bad = cli(["install", join(base, "nope"), "--dir", s, "--json"]);
  assert.notEqual(bad.status, 0);
  failEnvelope(bad);
  rmSync(base, { recursive: true, force: true });
});

test("bare restore JSON keeps its frozen failure envelope: unrestorable and retired carry their exact codes", () => {
  const base = temp();
  const s = scope(base);
  // A locked package whose source no longer exists cannot be restored.
  write(join(s, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 2,
    packages: { "x.p": { source: `path:${join(base, "gone")}`, path: ".", version: "1.0.0", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] } },
    capabilities: { "x.a": { version: "1.0.0", package: "x.p", path: "capabilities/a", integrity: `sha256-${"b".repeat(64)}`, trusted: false } },
  }, null, 2));

  const r = cli(["install", "--no-requirements", "--dir", s, "--json"], { cwd: s });
  assert.notEqual(r.status, 0, r.stdout);
  const err = failEnvelope(r, "E_RECONCILE_FAILED");
  // The COMPLETE report travels under error.details — a failure is still a
  // full report, not a bare message.
  const failed = err.details.scopes.flatMap((x) => x.artifacts).filter((a) => a.status !== "present");
  assert.ok(failed.length, JSON.stringify(err.details));
  assert.ok(failed.every((a) => typeof a.reason === "string" && a.reason), JSON.stringify(failed));

  // Human mode reports the same failure with a nonzero exit.
  const human = cli(["install", "--no-requirements", "--dir", s], { cwd: s });
  assert.notEqual(human.status, 0);
  assert.match(human.stdout + human.stderr, /FAILED/);
  rmSync(base, { recursive: true, force: true });
});

test("bulk package trust shows the FULL executable surface before approving, on stderr, keeping stdout one object", () => {
  const base = temp();
  const src = fixture(base);
  const s = scope(base);
  assert.equal(cli(["install", src, "--dir", s]).status, 0);

  const r = cli(["trust", "x.p", "--all-capabilities", "--dir", s, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const result = okEnvelope(r);
  // The pre-approval review is a SIDE CHANNEL: it must not contaminate stdout.
  assert.match(r.stderr, /full executable surface/i);
  assert.match(r.stderr, /x\.exec: commands \[go\], hooks \[spawn\]/);
  assert.match(r.stderr, /x\.plain: commands \[none\], hooks \[none\]/);

  assert.deepEqual(result.approved, ["x.exec"]);
  assert.deepEqual(result.skipped, ["x.plain"], "a capability with no executable surface needs no approval");
  assert.deepEqual(result.executableSurface["x.exec"], { commands: ["go"], hooks: ["spawn"] });
  assert.equal(lockOf(s).capabilities["x.exec"].trusted, true);
  assert.equal(lockOf(s).capabilities["x.plain"].trusted, false, "approving a package never trusts a non-executable capability");

  // A package identity that supplies nothing here is a typed refusal.
  failEnvelope(cli(["trust", "nope.pkg", "--all-capabilities", "--dir", s, "--json"]), "unknown-capability");
  rmSync(base, { recursive: true, force: true });
});

test("a valueless --dir is E_BAD_ARGS on every lifecycle command, in JSON and human mode, before any side effect", () => {
  const base = temp();
  const s = scope(base);
  const before = snapshot(s);
  // `doctor` is deliberately absent: it takes its context POSITIONALLY.
  for (const argv of [["install"], ["list"], ["trust", "x.a"], ["remove", "x.p"], ["migrate"]]) {
    const r = cli([...argv, "--dir", "--json"], { cwd: s });
    assert.notEqual(r.status, 0, `${argv[0]} accepted a valueless --dir`);
    // `--json` was consumed as the value of `--dir`, so this is NOT json mode:
    // the contract is the exit code and the typed message, on stderr.
    assert.match(r.stderr + r.stdout, /--dir/, `${argv[0]}: ${r.stderr}`);
  }
  assert.deepEqual(snapshot(s), before, "a usage error never touches the scope");
  rmSync(base, { recursive: true, force: true });
});

test("a valueless --dir is refused by the roster commands too, before any scaffold", () => {
  const base = temp();
  const s = scope(base);
  const before = snapshot(s);
  for (const argv of [["status"], ["spawn", "someone"], ["retire", "someone"], ["create", "someone"]]) {
    const r = cli([...argv, "--dir"], { cwd: s });
    assert.notEqual(r.status, 0, `${argv[0]} accepted a valueless --dir`);
  }
  assert.deepEqual(snapshot(s), before, "no agent home, no branch, no config write");
  rmSync(base, { recursive: true, force: true });
});

// ---------- fail-closed lock diagnosis ----------

/** Every shape the strict reader must refuse, with the command surfaces that
 * must refuse it identically. Kept as data so a new refusal is one row. */
/** A structurally VALID revised-v2 lock, with the given per-row overrides
 * merged in. Used to isolate exactly one shape violation per fixture row. */
function shaped({ packages = {}, capabilities = {} } = {}) {
  const pkg = { source: "path:/x", path: ".", version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`, dependencies: [] };
  const cap = { version: "1.0.0", package: "a.p", path: "capabilities/a", integrity: `sha256-${"1".repeat(64)}`, trusted: false };
  return {
    lockfileVersion: 2,
    packages: { "a.p": { ...pkg, ...(packages["a.p"] || {}) } },
    capabilities: { "a.cap": { ...cap, ...(capabilities["a.cap"] || {}) } },
  };
}

const REFUSED_LOCKS = [
  ["malformed JSON", "{ not json"],
  ["a non-object root", JSON.stringify([1, 2, 3])],
  ["a v2 document with no packages map", JSON.stringify({ lockfileVersion: 2, capabilities: {} })],
  ["the superseded transitional package-root v2 shape", JSON.stringify({
    lockfileVersion: 2,
    packages: { "a.b": { source: "path:/x", path: ".", version: "1.0.0", integrity: `sha256-${"0".repeat(64)}`, capabilities: ["a.cap"], trustedCapabilities: [] } },
  })],
  ["a v1 document carrying a packages map", JSON.stringify({ lockfileVersion: 1, packages: {}, capabilities: {} })],
  ["a malformed v1 entry", JSON.stringify({ lockfileVersion: 1, capabilities: { "a.cap": { source: "marketplace:a.cap@1", version: 1 } } })],
  ["an unknown lockfileVersion", JSON.stringify({ lockfileVersion: 99, packages: {}, capabilities: {} })],
  // Final rows are closed shapes: an unknown key is a lock from a FUTURE or
  // forked writer, and interpreting the keys we happen to recognise would
  // silently drop whatever the rest meant.
  ["a package row with an unknown key", JSON.stringify(shaped({ packages: { "a.p": { surprise: 1 } } }))],
  ["a capability row with an unknown key", JSON.stringify(shaped({ capabilities: { "a.cap": { surprise: 1 } } }))],
  // The `package` back-reference is the single provider truth: it must resolve
  // inside the SAME packages map, or the capability has no provenance at all.
  ["a capability row naming a provider that is not locked", JSON.stringify(shaped({ capabilities: { "a.cap": { package: "nope" } } }))],
  // Raw JSON must never reach a real prototype through a map key.
  ["a packages map with a __proto__ key", '{"lockfileVersion":2,"packages":{"__proto__":{}},"capabilities":{}}'],
];

test("a lock the reader refuses is never served as usable-but-empty: list, doctor, update, remove and trust all fail closed", () => {
  const base = temp();
  for (const [label, body] of REFUSED_LOCKS) {
    const s = scope(base, `s-${label.replace(/\W+/g, "-")}`);
    write(join(s, OAS_LOCK_FILE), body);
    const before = snapshot(s);

    // Read paths AND write paths: a lock the central parser refuses must stop
    // acquisition too, or the writer would serialize a scope it never read.
    for (const argv of [["list"], ["update", "x.p"], ["remove", "x.p"], ["trust", "x.a"], ["install"], ["install", join(base, "src")]]) {
      const r = cli([...argv, "--dir", s, "--json"], { cwd: s });
      assert.notEqual(r.status, 0, `${argv[0]} on ${label} exited 0`);
      const err = failEnvelope(r);
      assert.ok(err.code, `${argv[0]} on ${label} produced an untyped failure`);
      assert.notEqual(err.code, "E_UNKNOWN_COMMAND");
    }
    // Doctor DIAGNOSES rather than dying — it is the report you reach for — but
    // it never renders the refused lock as data.
    const doc = cli(["doctor", s, "--json"], { cwd: s });
    const rendered = JSON.parse(doc.stdout);
    const diagnosed = rendered.error?.code === "invalid-lock" || rendered.packages?.lockError?.code === "invalid-lock";
    assert.ok(diagnosed, `${label}: doctor did not diagnose it — ${doc.stdout.slice(0, 300)}`);
    assert.doesNotMatch(doc.stdout, /residue/i, `${label}: no residue view exists`);

    assert.deepEqual(snapshot(s), before, `${label}: a refused read mutated the scope`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("migrate never rewrites a lock it does not understand, and says so with a typed code", () => {
  const base = temp();
  for (const [label, body] of REFUSED_LOCKS) {
    const s = scope(base, `m-${label.replace(/\W+/g, "-")}`);
    write(join(s, OAS_LOCK_FILE), body);
    const before = readFileSync(join(s, OAS_LOCK_FILE), "utf8");
    for (const argv of [["migrate", "--dry-run"], ["migrate"]]) {
      const r = cli([...argv, "--dir", s, "--json"], { cwd: s });
      assert.notEqual(r.status, 0, `${argv.join(" ")} on ${label} exited 0`);
      failEnvelope(r);
      assert.equal(readFileSync(join(s, OAS_LOCK_FILE), "utf8"), before, `${label}: ${argv.join(" ")} rewrote the lock`);
    }
  }
  rmSync(base, { recursive: true, force: true });
});

test("a retired capability keeps its typed code through install, restore and doctor — human mode nonzero too", () => {
  const base = temp();
  const s = scope(base);
  // A v1 lock naming a retired capability: it can never be restored, and the
  // user must be told to remove the entry rather than to reacquire it.
  const retired = "oas.web"; // the only retired id the kernel knows
  write(join(s, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: { [retired]: { source: `marketplace:${retired}@1.0.0`, version: "1.0.0", integrity: `sha256-${"a".repeat(64)}` } } }, null, 2));

  const r = cli(["install", "--no-requirements", "--dir", s, "--json"], { cwd: s });
  assert.notEqual(r.status, 0, r.stdout);
  const err = failEnvelope(r, "E_RECONCILE_FAILED");
  const rows = err.details.scopes.flatMap((x) => x.artifacts).filter((a) => a.id === retired);
  assert.deepEqual(rows.map((a) => a.status), ["retired"], JSON.stringify(err.details));
  assert.equal(rows[0].code, "retired-capability");

  const human = cli(["install", "--no-requirements", "--dir", s], { cwd: s });
  assert.notEqual(human.status, 0, "a retired lock is not a successful restore");
  assert.match(human.stdout, /RETIRED/);

  // Acquiring it fresh is refused with the same code, before any fetch.
  failEnvelope(cli(["install", retired, "--dir", s, "--json"], { cwd: s }), "retired-capability");
  rmSync(base, { recursive: true, force: true });
});

test("doctor reports a malformed v1 lock at a CONFIGLESS scope — human and JSON agree", () => {
  const base = temp();
  const ws = scope(base, "ws", "name: ws\nteam:\n  name: t\n");
  // A lock-only scope: no oas-config.yaml, so the config chain never reaches it
  // and only the raw lock walk can see it.
  const member = join(ws, "member");
  mkdirSync(member, { recursive: true });
  write(join(member, OAS_LOCK_FILE), JSON.stringify({ lockfileVersion: 1, capabilities: { "a.cap": { source: "marketplace:a.cap@1", version: 1 } } }, null, 2));

  // Doctor is the ONE consumer that catches the fail-closed read: it still
  // reports, and it reports the fault as a single top-level `lockError` naming
  // the offending file — never as partially parsed entries.
  const dj = JSON.parse(cli(["doctor", member, "--json"], { cwd: ws }).stdout);
  assert.equal(dj.lockError?.code, "invalid-lock", JSON.stringify(dj).slice(0, 300));
  assert.equal(dj.lockError.file, join(member, OAS_LOCK_FILE));
  assert.match(dj.lockError.message, /legacy entry "a\.cap" is malformed/);
  assert.deepEqual(dj.packages, [], "a refused lock yields NO package rows");
  assert.deepEqual(dj.capabilities, [], "and no capability rows");

  const human = cli(["doctor", member], { cwd: ws });
  assert.match(human.stdout, /ERROR: .*malformed.*\[invalid-lock\]/, "the human report names the same fault");
  assert.match(human.stdout, /never auto-repaired/, "and says the lock is not repaired for you");
  rmSync(base, { recursive: true, force: true });
});

// ---------- the orphan check reads BOTH lock shapes ----------

test("doctor's orphan check consults the v2 capabilities map: a locked artifact is not an orphan, an unlocked one still is", () => {
  const base = temp();
  const src = fixture(base);
  const s = scope(base);
  assert.equal(cli(["install", src, "--dir", s]).status, 0);
  assert.equal(lockOf(s).lockfileVersion, 2, "the fixture must actually be v2-locked");
  assert.ok(lockOf(s).capabilities["x.plain"], "and the capability must carry a v2 lock row");

  // The regression: reading only the LEGACY v1 map, doctor called every
  // correctly materialized v2 capability an orphan and told the operator to
  // reacquire artifacts that were already exactly locked.
  const clean = cli(["doctor", s], { cwd: s });
  assert.equal(clean.status, 0, clean.stderr);
  assert.doesNotMatch(clean.stdout, /has no lock entry/, "a v2-locked artifact was reported as an orphan");

  // A GENUINE orphan in the same scope still warns, and names only itself.
  write(join(artifact(s, "x.stray"), "oas.json"), JSON.stringify({ capability: "x.stray", version: "1.0.0", description: "cap" }));
  const dirty = cli(["doctor", s], { cwd: s });
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.match(dirty.stdout, /WARNING: x\.stray at .* is in installed\/ but has no lock entry — reacquire it or move it to owned\//);
  assert.doesNotMatch(dirty.stdout, /WARNING: x\.plain at .* has no lock entry/, "the locked capability is still not an orphan");
  rmSync(base, { recursive: true, force: true });
});

test("a legacy v1 capability lock still answers the orphan check for its own artifact", () => {
  const base = temp();
  const s = scope(base);
  // An unconverted 0.18 scope: the artifact sits in the same flat installed/
  // store, and only the v1 map locks it.
  write(join(artifact(s, "x.legacy"), "oas.json"), JSON.stringify({ capability: "x.legacy", version: "1.0.0", description: "cap" }));
  write(join(s, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 1,
    capabilities: { "x.legacy": { source: `path:${join(base, "src")}`, version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`, trustedExecutables: false } },
  }, null, 2));

  const r = cli(["doctor", s], { cwd: s });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /has no lock entry/, "the v1 lock stopped answering for its artifact");
  rmSync(base, { recursive: true, force: true });
});

test("the v2 orphan check is SCOPE-EXACT: an outer scope's lock does not answer for an unlocked inner copy", () => {
  const base = temp();
  const src = fixture(base);
  const outer = scope(base, "outer");
  assert.equal(cli(["install", src, "--dir", outer]).status, 0);
  assert.ok(lockOf(outer).capabilities["x.plain"], "the outer scope must really be v2-locked");

  // An inner config scope holds its OWN unlocked copy of the same id. It wins
  // discovery precedence (inner beats outer) and is what actually activates,
  // so the outer scope's lock says nothing about it.
  const inner = join(outer, "inner");
  write(join(inner, "oas-config.yaml"), "name: inner\n");
  write(join(artifact(inner, "x.plain"), "oas.json"), JSON.stringify({ capability: "x.plain", version: "9.9.9", description: "cap" }));

  const r = cli(["doctor", inner], { cwd: inner });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARNING: x\.plain at .*inner.* is in installed\/ but has no lock entry/);
  rmSync(base, { recursive: true, force: true });
});

test("a lock-only ancestor never answers the orphan check for a config scope below it", () => {
  const base = temp();
  // A lock file with NO oas-config.yaml beside it: `readPackageLocks` walks it
  // (lock levels are not config levels), so the merged chain would have
  // silenced the orphan below — a strict widening over the legacy behaviour.
  write(join(base, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 2,
    packages: { "x.p": { source: `path:${join(base, "src")}`, path: ".", version: "1.0.0", commit: "local", integrity: `sha256-${"a".repeat(64)}`, dependencies: [] } },
    capabilities: { "x.plain": { version: "1.0.0", package: "x.p", path: "capabilities/plain", integrity: `sha256-${"b".repeat(64)}`, trusted: false } },
  }, null, 2));
  const s = scope(base);
  write(join(artifact(s, "x.plain"), "oas.json"), JSON.stringify({ capability: "x.plain", version: "1.0.0", description: "cap" }));

  const r = cli(["doctor", s], { cwd: s });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARNING: x\.plain at .* is in installed\/ but has no lock entry/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- internal annotations are unforgeable ----------

test("an artifact cannot declare the kernel's own annotations: a spoofed _capabilityLock does not silence the orphan warning", () => {
  const base = temp();
  const src = fixture(base);
  const s = scope(base);
  assert.equal(cli(["install", src, "--dir", s]).status, 0);

  // A genuinely UNLOCKED artifact whose own oas.json asserts the kernel's
  // internal annotations about itself. `_capabilityLock` is the scope-exact lock
  // row the orphan check consults, so spreading the parsed manifest let an
  // artifact nothing locks claim to be locked — and `_origin`/`_dir` are the
  // provenance every consumer reads.
  const realDir = artifact(s, "x.spoof");
  write(join(realDir, "oas.json"), JSON.stringify({
    capability: "x.spoof", version: "1.0.0", description: "cap",
    _capabilityLock: { version: "1.0.0", package: "x.p", path: "capabilities/plain", integrity: `sha256-${"c".repeat(64)}`, trusted: true },
    _package: "x.p",
    _origin: "owned:/elsewhere",
    _dir: "/elsewhere",
  }));

  const d = cli(["doctor", s], { cwd: s });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /WARNING: x\.spoof at .* is in installed\/ but has no lock entry/);
  assert.doesNotMatch(d.stdout, /\/elsewhere/, "the artifact's declared _dir must never be reported as its location");
  // The correctly locked neighbour is still not an orphan (control).
  assert.doesNotMatch(d.stdout, /WARNING: x\.plain .* has no lock entry/);

  const j = JSON.parse(cli(["doctor", s, "--json"], { cwd: s }).stdout);
  assert.equal(j.acquired["x.spoof"].origin, `installed:${s}`, "origin is the kernel's finding, not the artifact's claim");
  assert.equal(j.acquired["x.spoof"].dir, realDir);
  rmSync(base, { recursive: true, force: true });
});

test("a soul.yaml cannot declare _soulDir or _dir about itself", () => {
  const base = temp();
  const root = join(base, "agents");
  // `_soulDir` is consumed as "the read-only soul inside a package" and `_dir`
  // as the agent home: a soul that could declare either would be redirecting
  // its own spawn.
  write(join(root, "ghost", "soul", "soul.yaml"), "name: ghost\n_soulDir: /elsewhere/soul\n_dir: /elsewhere\n");
  const agent = findAgent(root, "ghost");
  assert.equal(agent.name, "ghost");
  assert.equal(agent._soulDir, undefined, "the soul declared its own package-soul directory");
  assert.equal(agent._dir, join(root, "ghost"));
  rmSync(base, { recursive: true, force: true });
});

// ---------- canonical dispatch ----------

test("a capability command runs through the CLI that dispatched it: a hostile PATH cannot intercept it", () => {
  const base = temp();
  // A capability whose command prints the oas binary its own environment names.
  const src = pkgSource(join(base, "src"), "x.cmd", {
    "capabilities/c": {
      capability: "x.cmd", command: "demo",
      commands: { show: "show.mjs" },
      _files: { "show.mjs": "console.log(JSON.stringify({ cli: process.env.OAS_CLI_BIN || null }));\n" },
    },
  });
  const s = scope(base, "scope", "name: t\ncapabilities:\n  additive:\n    x.cmd:\n      from: installed\n      global: true\n");
  assert.equal(cli(["install", src, "--dir", s]).status, 0);
  assert.equal(cli(["trust", "x.cmd", "--dir", s]).status, 0);

  // An impostor `oas` earlier on PATH than anything else.
  const evil = join(base, "evil");
  mkdirSync(evil, { recursive: true });
  write(join(evil, "oas"), "#!/bin/sh\necho INTERCEPTED\nexit 0\n");
  chmodSync(join(evil, "oas"), 0o755);

  const r = cli(["demo", "show", "--dir", s], { cwd: s, env: { PATH: `${evil}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /INTERCEPTED/, "the impostor on PATH must never be reached");
  const seen = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(seen.cli, CLI, "OAS_CLI_BIN names the dispatching CLI, by absolute path");
  rmSync(base, { recursive: true, force: true });
});

test("the Desktop version probe is unchanged: `oas version --json` still answers without any deployment state", () => {
  const base = temp();
  const s = scope(base);
  // Even a scope whose lock the kernel refuses must not break the probe — it is
  // how the Desktop decides whether a kernel is usable at all.
  write(join(s, OAS_LOCK_FILE), "{ not json");
  const r = cli(["version", "--json"], { cwd: s });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(r.stdout.trim(), JSON.stringify(doc), "exactly one JSON document");
  assert.match(doc.version, /^\d+\.\d+\.\d+/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- the runtime boundary a dispatched command sees ----------

test("a dispatched command receives its capability identity and EFFECTIVE settings, not the raw config", () => {
  const base = temp();
  const src = pkgSource(join(base, "src"), "s.p", {
    "capabilities/c": {
      capability: "s.cap", command: "svc", commands: { env: "env.mjs" },
      _files: { "env.mjs": "console.log(JSON.stringify({ cap: process.env.OAS_CAPABILITY, settings: process.env.OAS_SETTINGS, team: process.env.OAS_TEAM_NAME }));\n" },
    },
  });
  // Two scopes declare the SAME capability with different settings: the value
  // handed to the child must come from the scope it runs in, not from the
  // manifest and not from whatever config happens to be nearest the cwd.
  const mk = (name, level) => scope(base, name, `name: ${name}\nteam:\n  name: crew\ncapabilities:\n  additive:\n    s.cap:\n      from: installed\n      global: true\n      settings:\n        level: ${level}\n`);
  for (const [name, level] of [["a", "loud"], ["b", "quiet"]]) {
    const dir = mk(name, level);
    assert.equal(cli(["install", src, "--dir", dir]).status, 0);
    assert.equal(cli(["trust", "s.cap", "--dir", dir]).status, 0);
    const r = cli(["svc", "env", "--dir", dir], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.equal(seen.cap, "s.cap", "OAS_CAPABILITY names the dispatching capability");
    assert.deepEqual(JSON.parse(seen.settings), { level }, `${name}: settings came from the wrong scope`);
    assert.equal(seen.team, "crew", "the team context travels with the dispatch");
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- artifact integrity is the trust anchor ----------

test("a drifted capability artifact is DIAGNOSED by doctor and list, and REPAIRED by a bare restore", () => {
  const base = temp();
  const src = fixture(base);
  const s = scope(base);
  assert.equal(cli(["install", src, "--dir", s]).status, 0);
  assert.equal(cli(["trust", "x.exec", "--dir", s]).status, 0);
  const locked = lockOf(s).capabilities["x.exec"].integrity;

  // Tamper INSIDE the materialized artifact — the runtime closure, not the
  // manifest — so only a whole-artifact hash can see it.
  const go = join(artifact(s, "x.exec"), "bin", "go.mjs");
  write(go, "// tampered\n");

  const listed = okEnvelope(cli(["list", "--dir", s, "--json"], { cwd: s })).capabilities.find((c) => c.capability === "x.exec");
  assert.equal(listed.status, "drifted");
  assert.equal(listed.code, "integrity-drift");
  assert.notEqual(listed.installedIntegrity, locked, "the drifted hash is reported, not the locked one");

  const doc = JSON.parse(cli(["doctor", s, "--json"], { cwd: s }).stdout);
  assert.ok(JSON.stringify(doc).includes("integrity-drift"), "doctor names the same fault");

  // Trust must not survive a drifted artifact: dispatch is blocked even though
  // the lock still says trusted.
  assert.equal(lockOf(s).capabilities["x.exec"].trusted, true, "the lock flag itself is untouched");
  const blocked = cli(["demo", "go", "--dir", s, "--json"], { cwd: s });
  assert.notEqual(blocked.status, 0, "a drifted artifact still dispatched");

  // A bare restore re-materializes it back to the locked bytes.
  assert.equal(cli(["install", "--no-requirements", "--dir", s], { cwd: s }).status, 0);
  assert.equal(readFileSync(go, "utf8"), "//\n", "restore did not repair the artifact");
  const repaired = okEnvelope(cli(["list", "--dir", s, "--json"], { cwd: s })).capabilities.find((c) => c.capability === "x.exec");
  assert.equal(repaired.installedIntegrity, locked);
  assert.notEqual(repaired.status, "drifted");
  rmSync(base, { recursive: true, force: true });
});

// ---------- the cutover gate ----------

test("after conversion the scope holds ZERO v1 locks and no package store anywhere", () => {
  const base = temp();
  const src = fixture(base);
  const s = scope(base);
  // Start from a real 0.18 scope: a v1 capability lock whose source is a tree
  // that DOES export a distribution package, which is what makes it convertible.
  write(join(s, OAS_LOCK_FILE), JSON.stringify({
    lockfileVersion: 1,
    capabilities: { "x.plain": { source: `path:${src}`, version: "1.0.0", commit: "local", integrity: `sha256-${"0".repeat(64)}`, trustedExecutables: false } },
  }, null, 2));
  assert.equal(lockOf(s).lockfileVersion, 1, "the fixture must actually start at v1");

  const r = cli(["migrate", "--dir", s, "--json"], { cwd: s });
  assert.equal(r.status, 0, r.stdout);
  const lock = lockOf(s);
  assert.equal(lock.lockfileVersion, 2);
  assert.ok(lock.packages && lock.capabilities, "revised v2 carries BOTH required top-level maps");
  // The cutover gate, stated as an invariant over the whole tree.
  const files = Object.keys(snapshot(s));
  assert.equal(files.filter((f) => /(^|\/)\.agents\/packages(\/|$)/.test(f)).length, 0, "a package store was materialized");
  assert.deepEqual(JSON.parse(cli(["doctor", s, "--json"], { cwd: s }).stdout).legacyLockFiles, [],
    "doctor still sees a v1 lock after the cutover");
  // And installing a real package afterwards keeps the shape.
  assert.equal(cli(["install", src, "--dir", s]).status, 0);
  assert.equal(lockOf(s).lockfileVersion, 2);
  assert.equal(Object.keys(snapshot(s)).filter((f) => f.includes(".agents/packages/")).length, 0);
  rmSync(base, { recursive: true, force: true });
});

// ---------- retired flags reject before they can scaffold ----------

test("retired spawn flags are refused BEFORE any instance home is scaffolded", () => {
  const base = temp();
  const s = gitify(scope(base, "repo", "name: repo\n"));
  const before = snapshot(s);
  for (const argv of [["spawn", "someone", "--instance", "x"], ["spawn", "someone", "--ephemeral"]]) {
    const r = cli([...argv, "--dir", s, "--json"], { cwd: s });
    assert.notEqual(r.status, 0, `${argv.join(" ")} exited 0`);
    assert.equal(failEnvelope(r, "E_BAD_ARGS").code, "E_BAD_ARGS");
    assert.deepEqual(snapshot(s), before, `${argv.join(" ")} scaffolded before refusing`);
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- Git sources: payload root, and the standalone fallback ----------

/** A git repository at `dir`, committed. Returns the `file://` URL — the only
 * git spelling that works without a network, and the one that lets these cases
 * exercise the real fetch/probe path instead of the local exact-directory one
 * (a `path:` source is always the package root and takes no "#<path>"). */
function gitRepo(dir) {
  gitify(dir);
  return `file://${dir}`;
}

test("a package rooted in a payload SUBDIRECTORY: every command agrees, and no row carries depsIntegrity", () => {
  const base = temp();
  const repo = join(base, "repo");
  pkgSource(join(repo, "pkgs", "x"), "g.p", {
    "capabilities/c": { capability: "g.cap", commands: { go: "bin/go.mjs" }, _files: { "bin/go.mjs": "//\n" } },
  });
  const url = gitRepo(repo);
  const s = scope(base);

  const r = cli(["install", `${url}#pkgs/x`, "--dir", s, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const lock = lockOf(s);
  const pkg = lock.packages["g.p"];
  assert.equal(pkg.path, "pkgs/x", "the lock records the payload root, not the repository root");
  assert.match(pkg.commit, /^[0-9a-f]{40}$/, "a git package pins an exact commit");
  // The package row locks the TRANSPORT only: no capability list, no per-package
  // trust set, and no separate dependency digest.
  assert.deepEqual(Object.keys(pkg).sort(), ["commit", "dependencies", "integrity", "path", "source", "version"]);
  assert.equal(JSON.stringify(lock).includes("depsIntegrity"), false, "depsIntegrity is gone from the format");
  // The capability row's `package` back-reference is the single provider truth.
  assert.equal(lock.capabilities["g.cap"].package, "g.p");
  assert.equal(lock.capabilities["g.cap"].path, "capabilities/c");

  // Every reader agrees with the lock, and trust binds to the ARTIFACT.
  const listed = okEnvelope(cli(["list", "--dir", s, "--json"], { cwd: s })).capabilities.find((c) => c.capability === "g.cap");
  assert.equal(listed.package, "g.p");
  assert.equal(listed.integrity, lock.capabilities["g.cap"].integrity);
  assert.equal(listed.status, "untrusted", "an executable surface starts untrusted");
  // `approvedIntegrity` is keyed by capability: approval is per capability
  // artifact, and a bulk approval reports each one it bound to.
  assert.deepEqual(okEnvelope(cli(["trust", "g.cap", "--dir", s, "--json"], { cwd: s })).approvedIntegrity,
    { "g.cap": listed.integrity });

  // And a bare restore of the payload-rooted package is exact.
  const after = snapshot(join(s, ".agents"));
  assert.equal(cli(["install", "--no-requirements", "--dir", s], { cwd: s }).status, 0);
  assert.deepEqual(snapshot(join(s, ".agents")), after, "restore rewrote a byte of the materialized closure");
  rmSync(base, { recursive: true, force: true });
});

test("the Git package probe precedes the standalone route: it falls back only when there is NO package manifest", () => {
  const base = temp();

  // (a) No package manifest anywhere, but a capability root: the CLI falls back
  // to the standalone route and locks it the v1 way, transactionally.
  const plainRepo = join(base, "plain");
  write(join(plainRepo, "oas.json"), JSON.stringify({ capability: "s.cap", version: "1.0.0", description: "standalone" }, null, 2));
  const a = scope(base, "a");
  assert.equal(cli(["install", gitRepo(plainRepo), "--dir", a]).status, 0);
  const v1 = lockOf(a);
  assert.equal(v1.lockfileVersion, 1);
  assert.equal(v1.capabilities["s.cap"].trustedExecutables, false);
  assert.equal(v1.packages, undefined, "the standalone route never invents a packages map");

  // (b) Neither: the failure names BOTH probes, so the operator can tell which
  // shape the source was expected to have.
  const emptyRepo = join(base, "empty");
  write(join(emptyRepo, "README.md"), "nothing here\n");
  const b = scope(base, "b");
  const none = cli(["install", gitRepo(emptyRepo), "--dir", b, "--json"]);
  assert.notEqual(none.status, 0);
  const err = failEnvelope(none);
  assert.match(err.message, /no oas-package\.json at package path "oas-package"/);
  assert.match(err.message, /no oas\.json at its root/);
  assert.equal(existsSync(join(b, OAS_LOCK_FILE)), false, "a refused probe left a lock behind");

  // (c) A BROKEN package manifest is a package error, never a silent demotion
  // to the standalone route — even when a usable oas.json sits at the root.
  const brokenRepo = join(base, "broken");
  write(join(brokenRepo, "oas-package", "oas-package.json"), "{ not json");
  write(join(brokenRepo, "oas.json"), JSON.stringify({ capability: "decoy.cap", version: "1.0.0", description: "decoy" }, null, 2));
  const c = scope(base, "c");
  const broken = cli(["install", gitRepo(brokenRepo), "--dir", c, "--json"]);
  assert.notEqual(broken.status, 0, "a broken package manifest was silently demoted to the standalone route");
  assert.doesNotMatch(JSON.stringify(failEnvelope(broken)), /decoy\.cap/, "the decoy capability must never be reached");
  assert.equal(existsSync(join(c, OAS_LOCK_FILE)), false, "a failed package probe left a lock behind");

  // (d) A repository that DOES carry a package at its root, but nothing at the
  // default package path, must not downgrade to the standalone route either —
  // it is told exactly how to select the root instead.
  const rootPkgRepo = join(base, "rootpkg");
  pkgSource(rootPkgRepo, "r.p", { "capabilities/c": { capability: "r.cap" } });
  write(join(rootPkgRepo, "oas.json"), JSON.stringify({ capability: "decoy2.cap", version: "1.0.0", description: "decoy" }, null, 2));
  const d = scope(base, "d");
  const rooted = cli(["install", gitRepo(rootPkgRepo), "--dir", d, "--json"]);
  assert.notEqual(rooted.status, 0, "a root package was skipped in favour of the standalone route");
  const rootedErr = failEnvelope(rooted, "invalid-package-manifest");
  assert.match(rootedErr.message, /oas-package\.json at the repository ROOT/);
  assert.match(rootedErr.message, /#\./, "the message names the exact spelling that selects the root");
  assert.equal(existsSync(join(d, OAS_LOCK_FILE)), false);
  // And that spelling actually works.
  assert.equal(cli(["install", `${gitRepo(rootPkgRepo)}#.`, "--dir", d]).status, 0);
  assert.equal(lockOf(d).packages["r.p"].path, ".");
  rmSync(base, { recursive: true, force: true });
});

// ---------- an upstream package-root move ----------

test("an upstream package-root move: restore stays exact, a git selection is sticky, a catalog root is adopted and reported", () => {
  const base = temp();
  const repo = join(base, "repo");
  const layout = (root) => pkgSource(join(repo, ...root.split("/")), "g.p", { "capabilities/c": { capability: "g.cap" } });
  layout("pkgs/x");
  const url = gitRepo(repo);
  const catalogFile = join(base, "catalog.json");
  const writeCatalog = (path) => writeFileSync(catalogFile,
    JSON.stringify({ packages: { "g.p": { url, path } }, capabilities: { "g.cap": "g.p" } }, null, 2));
  writeCatalog("pkgs/x");

  const git = scope(base, "git");
  const cat = scope(base, "cat");
  const cat2 = scope(base, "cat2"); // the same catalog install, kept for the drift branch
  assert.equal(cli(["install", `${url}#pkgs/x`, "--dir", git]).status, 0);
  for (const d of [cat, cat2]) assert.equal(cli(["install", "g.p", "--dir", d], { catalog: catalogFile }).status, 0);
  const lockedCommit = lockOf(git).packages["g.p"].commit;

  // Upstream moves the package root and the catalog follows it.
  execFileSync("git", ["-C", repo, "rm", "-r", "-q", "pkgs"]);
  layout("packages/x");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "move the package root"]);
  writeCatalog("packages/x");

  // Restore is pinned to the LOCKED commit, where the old root still exists —
  // a move upstream can never break an existing deployment.
  for (const s of [git, cat]) {
    const before = snapshot(join(s, ".agents"));
    assert.equal(cli(["install", "--no-requirements", "--dir", s], { cwd: s, catalog: catalogFile }).status, 0, `${s}: restore broke`);
    assert.deepEqual(snapshot(join(s, ".agents")), before, `${s}: restore was not byte-exact`);
    assert.equal(lockOf(s).packages["g.p"].commit, lockedCommit);
  }

  // A GIT spec's path is the operator's own selection, so it stays sticky: the
  // update re-reads the same root and fails rather than guessing a new one.
  const stuck = cli(["update", "g.p", "--dir", git, "--json"], { cwd: git });
  assert.notEqual(stuck.status, 0);
  assert.match(failEnvelope(stuck).message, /package path "pkgs\/x" is not a directory/);
  assert.equal(lockOf(git).packages["g.p"].path, "pkgs/x", "a failed update moved the lock");
  // And acquisition never advances a locked source, whatever path you name.
  // The refusal must name the route that can ACTUALLY resolve it: for a git
  // spec that is remove + re-install, never `oas update` (which would keep the
  // sticky selection and fail on the stale path).
  const reacquire = cli(["install", `${url}#packages/x`, "--dir", git, "--json"], { cwd: git });
  const gitErr = failEnvelope(reacquire, "integrity-drift");
  assert.match(gitErr.message, /oas remove g\.p/);
  assert.match(gitErr.message, /config or dependent packages/, "removal blockers are stated up front");
  assert.doesNotMatch(gitErr.message, /use `oas update/, "update cannot move a sticky git selection");

  // A CATALOG entry owns its path, so an explicit update adopts the moved root
  // — and says so, even though the payload bytes are unchanged.
  const moved = cli(["update", "g.p", "--dir", cat, "--json"], { cwd: cat, catalog: catalogFile });
  assert.equal(moved.status, 0, moved.stderr);
  const r = okEnvelope(moved);
  assert.equal(r.pathChanged, true);
  assert.equal(r.before.path, "pkgs/x");
  assert.equal(r.after.path, "packages/x");
  assert.equal(lockOf(cat).packages["g.p"].path, "packages/x");
  const human = cli(["update", "g.p", "--dir", cat], { cwd: cat, catalog: catalogFile });
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout, /MOVED/, "a second update has nothing left to move");

  // The catalog branch of the same refusal: re-acquiring a catalog package whose
  // root has moved DOES point at `oas update`, because the catalog owns the path.
  const catErr = failEnvelope(cli(["install", "g.p", "--dir", cat2, "--json"], { cwd: cat2, catalog: catalogFile }), "integrity-drift");
  assert.match(catErr.message, /use `oas update g\.p`/);
  assert.doesNotMatch(catErr.message, /oas remove/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- B1: a capability id is a directory name, never a path ----------

/** Ids that must never reach a filesystem join. Each is a spelling an attacker
 * (or a careless publisher) could put in a lock or a package manifest. */
const HOSTILE_CAPABILITY_IDS = [
  "..",
  ".",
  "../evil",
  "../../evil",
  "a/../../evil",
  "sub/child",
  "sub\\child",
  "/etc/passwd",
  "~/evil",
  "%2e%2e%2fevil",
  "..%2fevil",
  "x@1.0.0",
  // Refused by grammar: a leading underscore is outside [a-z0-9], and this is
  // the one prototype name that can reach a real Object.prototype.
  "__proto__",
  "UPPER.case",
  "-leading-dash",
  "",
];

test("a hostile capability id in a raw lock is refused by the READER — every command fails closed, bytes untouched", () => {
  const base = temp();
  for (const [i, id] of HOSTILE_CAPABILITY_IDS.entries()) {
    const s = scope(base, `raw-${i}`);
    // Hand-written lock: the key never passed through any writer.
    write(join(s, OAS_LOCK_FILE), `{
      "lockfileVersion": 2,
      "packages": { "a.p": { "source": "path:/x", "path": ".", "version": "1.0.0", "commit": "local", "integrity": "sha256-${"0".repeat(64)}", "dependencies": [] } },
      "capabilities": { ${JSON.stringify(id)}: { "version": "1.0.0", "package": "a.p", "path": "capabilities/a", "integrity": "sha256-${"1".repeat(64)}", "trusted": false } }
    }`);
    const before = snapshot(s);

    for (const argv of [["list"], ["install"], ["update", "a.p"], ["remove", "a.p"], ["trust", "a.p"], ["migrate"]]) {
      const r = cli([...argv, "--dir", s, "--json"], { cwd: s });
      assert.notEqual(r.status, 0, `${argv[0]} accepted capability id ${JSON.stringify(id)}`);
      assert.equal(failEnvelope(r).code, "invalid-lock", `${argv[0]} on ${JSON.stringify(id)} was not a typed lock refusal`);
    }
    // Doctor diagnoses rather than dying. Which of the two typed shapes it uses
    // depends on how early the refusal fires — resolution raises before the
    // package report is even computed — but the CODE is the same either way,
    // and no capability row is ever rendered.
    const doc = JSON.parse(cli(["doctor", s, "--json"], { cwd: s }).stdout);
    assert.equal(doc.error?.code || doc.lockError?.code, "invalid-lock", `doctor did not diagnose ${JSON.stringify(id)}: ${JSON.stringify(doc).slice(0, 200)}`);
    assert.deepEqual(doc.capabilities || [], [], "a refused lock rendered capability rows");

    assert.deepEqual(snapshot(s), before, `a refused id mutated the scope: ${JSON.stringify(id)}`);
    // Nothing was ever created outside the scope either.
    assert.equal(existsSync(join(base, "evil")), false, `${JSON.stringify(id)} escaped the scope`);
    assert.equal(existsSync(join(s, "..", "evil")), false);
  }
  rmSync(base, { recursive: true, force: true });
});

test("prototype-shaped ids that DO satisfy the grammar are ordinary data, and forge nothing", () => {
  const base = temp();
  // Namespaced prototype-shaped identities are valid — lowercase, no path
  // characters — and they must stay valid: refusing them would be grammar
  // theatre. What makes them safe is that every returned map is null-prototype,
  // so they are keys and never inherited properties. (`__proto__` itself is
  // refused, but only because a leading underscore is outside the grammar's
  // first character class.)
  const s = scope(base);
  const ids = ["x.constructor", "x.prototype", "x.__proto__"];
  const src = pkgSource(join(base, "src"), "p.p", {
    "capabilities/c": { capability: ids[0] },
    "capabilities/p": { capability: ids[1] },
    "capabilities/u": { capability: ids[2] },
  });
  const r = cli(["install", src, "--dir", s, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lock = lockOf(s);
  assert.deepEqual(Object.keys(lock.capabilities).sort(), [...ids].sort());

  const listed = okEnvelope(cli(["list", "--dir", s, "--json"], { cwd: s })).capabilities;
  assert.deepEqual(listed.map((c) => c.capability).sort(), [...ids].sort());
  // Each resolved to its OWN row, not to something inherited: the provider and
  // the artifact path are the real ones, and both artifacts exist side by side.
  for (const c of listed) {
    assert.equal(c.package, "p.p", `${c.capability} lost its provider`);
    assert.equal(existsSync(join(artifact(s, c.capability), "oas.json")), true, `${c.capability} was not materialized`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("a package exporting a hostile capability id cannot be acquired — nothing is materialized", () => {
  const base = temp();
  // The manifest reader is looser for LEGACY standalone capabilities (they are
  // named by basename, never by the id), so these ids reach package validation
  // and must be refused there, before any artifact directory is created.
  // Two refusal families, both before any artifact directory exists:
  //   - ids carrying "." / "@" / "/" satisfy the loose LEGACY namespacing rule
  //     and reach package validation, which refuses them as manifest faults;
  //   - bare ids such as "__proto__" are refused even earlier, by that same
  //     legacy namespacing rule, and surface as a source fault.
  // The invariant under test is the same: refused, typed, nothing materialized.
  const MANIFEST_FAULTS = ["../evil", "sub/child", "/etc/passwd", "x@1.0.0"];
  for (const [i, id] of [...MANIFEST_FAULTS, "__proto__", "constructor"].entries()) {
    const src = join(base, `src-${i}`);
    write(join(src, "capabilities/a/oas.json"), JSON.stringify({ capability: id, version: "1.0.0", description: "hostile" }, null, 2));
    write(join(src, "oas-package.json"), JSON.stringify({
      package: "h.p", version: "1.0.0", description: "hostile", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"],
    }, null, 2));
    const s = scope(base, `acq-${i}`);
    const before = snapshot(s);
    const r = cli(["install", src, "--dir", s, "--json"]);
    assert.notEqual(r.status, 0, `install accepted exported id ${JSON.stringify(id)}`);
    const code = failEnvelope(r).code;
    assert.equal(code, MANIFEST_FAULTS.includes(id) ? "invalid-package-manifest" : "invalid-source",
      `${JSON.stringify(id)} was refused with an unexpected code`);
    assert.deepEqual(snapshot(s), before, `a refused export mutated the scope: ${JSON.stringify(id)}`);
    assert.equal(existsSync(join(s, OAS_LOCK_FILE)), false, "a refused acquisition wrote a lock");
    assert.equal(existsSync(join(base, "evil")), false);
  }
  rmSync(base, { recursive: true, force: true });
});

// ---------- I4: a capability's provider is resolved at ITS OWN level ----------

test("nested scopes locking the same package id at different versions keep their own provenance", () => {
  const base = temp();
  // The same package IDENTITY at two versions, exporting DISJOINT capabilities.
  // The merged lock view resolves each identity independently — closest wins —
  // so the inner x.p@2 row is what `locks.packages["x.p"]` returns even for the
  // outer scope's x.b. Provenance must not come from there.
  const outerSrc = pkgSource(join(base, "outer-src"), "x.p", { "capabilities/b": { capability: "x.b" } }, { version: "1.0.0" });
  write(join(outerSrc, "oas-package.json"), JSON.stringify({
    package: "x.p", version: "1.0.0", description: "outer", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/b"],
  }, null, 2));
  const innerSrc = pkgSource(join(base, "inner-src"), "x.p", { "capabilities/a": { capability: "x.a", commands: { go: "go.mjs" }, _files: { "go.mjs": "//\n" } } });
  write(join(innerSrc, "oas-package.json"), JSON.stringify({
    package: "x.p", version: "2.0.0", description: "inner", compatibility: { oas: ">=0.1.0" }, capabilities: ["capabilities/a"],
  }, null, 2));

  const outer = scope(base, "outer");
  const inner = join(outer, "inner");
  write(join(inner, "oas-config.yaml"), "name: inner\n");
  assert.equal(cli(["install", outerSrc, "--dir", outer]).status, 0);
  assert.equal(cli(["install", innerSrc, "--dir", inner]).status, 0);
  assert.equal(lockOf(outer).packages["x.p"].version, "1.0.0");
  assert.equal(lockOf(inner).packages["x.p"].version, "2.0.0");

  // From the inner scope BOTH capabilities are visible, and each must report
  // the version of the package that actually exported it.
  const envelope2 = okEnvelope(cli(["list", "--dir", inner, "--json"], { cwd: inner }));
  const listed = envelope2.capabilities;
  const byId = Object.fromEntries(listed.map((c) => [c.capability, c]));
  assert.ok(byId["x.a"] && byId["x.b"], `both capabilities must be visible: ${listed.map((c) => c.capability).join(", ")}`);
  // Each capability is attributed to the scope that actually locked it — the
  // outer one must not be re-homed onto the nearer package of the same id.
  assert.equal(byId["x.b"].level, outer, "the outer capability was attributed to the inner scope");
  assert.equal(byId["x.a"].level, inner);
  // Both package rows survive, each at its own version and level.
  const providers = envelope2.packages.filter((p) => p.package === "x.p")
    .map((p) => [p.level, p.version]).sort();
  assert.deepEqual(providers, [[inner, "2.0.0"], [outer, "1.0.0"]].sort(),
    `both provider rows must survive: ${JSON.stringify(envelope2.packages)}`);
  // Neither is reported as damaged: same-level provenance agrees for both.
  for (const c of listed) assert.notEqual(c.status, "provenance-mismatch", `${c.capability}: ${c.detail}`);

  // Trusting the package from the inner scope writes ONLY inner rows: the outer
  // lock is not this command's to rewrite.
  const outerBefore = readFileSync(join(outer, OAS_LOCK_FILE), "utf8");
  const t = cli(["trust", "x.p", "--all-capabilities", "--dir", inner, "--json"], { cwd: inner });
  assert.equal(t.status, 0, t.stdout);
  assert.deepEqual(okEnvelope(t).approved, ["x.a"], "a bulk approval crossed a lock level");
  assert.equal(readFileSync(join(outer, OAS_LOCK_FILE), "utf8"), outerBefore, "the outer lock was rewritten");
  assert.equal(lockOf(inner).capabilities["x.a"].trusted, true);
  assert.equal(lockOf(outer).capabilities["x.b"].trusted, false, "an outer capability was silently trusted");
  rmSync(base, { recursive: true, force: true });
});
