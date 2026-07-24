// Desktop CLI API v1 contract tests — the FIXED JSON shapes the Desktop app
// consumes (see docs/desktop-cli-api.md and the desktop-dist contract).
//
// Invariants under test:
//   * `oas version --json` prints EXACTLY the probe payload, one JSON object:
//     {"schemaVersion":1,"name":"@oas-framework/oas","version":<pkg>,"desktopApi":1}
//   * `oas spawn ... --json` success prints one envelope object
//     {"schemaVersion":1,"ok":true,"result":{instance,agent,home,work,branch,
//      launched,warnings,tmux,...}} with no progress contamination on stdout.
//   * every `--json` failure prints one envelope object
//     {"schemaVersion":1,"ok":false,"error":{code,message}} on stdout, exits nonzero.
//   * `oas okf harvest --json` distinguishes spawned/skipped via
//     result.harvest, with instance/window or reason.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CLI = resolve(new URL("../bin/oas.mjs", import.meta.url).pathname);
const PKG_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const OKF_BIN = resolve(new URL("../capabilities/oas-okf/bin/oas-okf.mjs", import.meta.url).pathname);

function temp() { return mkdtempSync(join(tmpdir(), "oas-json-contract-")); }
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  write(join(dir, ".gitignore"), "\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
}
function fakeRuntimes(base) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  for (const name of ["pi", "claude"]) { write(join(bin, name), "#!/bin/sh\nexit 0\n"); execFileSync("chmod", ["+x", join(bin, name)]); }
  return `${bin}:${process.env.PATH}`;
}
function fixtureSoul(base) {
  const repo = join(base, "repo"); gitRepo(repo);
  const root = join(base, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nruntime: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# dev\n");
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  return { repo, root };
}
/** stdout must be exactly one JSON document — anything else is contamination. */
function parseOnly(stdout) {
  const doc = JSON.parse(stdout);
  assert.equal(stdout.trim(), JSON.stringify(doc), "stdout is exactly one compact JSON object");
  return doc;
}

test("oas version --json emits the exact Desktop API v1 probe payload", () => {
  const r = spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const doc = parseOnly(r.stdout);
  assert.deepEqual(doc, { schemaVersion: 1, name: "@oas-framework/oas", version: PKG_VERSION, desktopApi: 1 });
  // key order is part of the published fixture — Desktop probes with string compare fallback
  assert.equal(r.stdout.trim(), `{"schemaVersion":1,"name":"@oas-framework/oas","version":"${PKG_VERSION}","desktopApi":1}`);
});

test("oas version human output stays ergonomic and mentions the version", () => {
  const r = spawnSync(process.execPath, [CLI, "version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(PKG_VERSION.replace(/\./g, "\\.")));
});

test("oas spawn --json success is one envelope with the contract result fields", () => {
  const base = temp(); const { repo } = fixtureSoul(base);
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
  delete env.PI_AGENTS_ROOT;
  const r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--task", "contract check", "--purpose", "ctr", "--no-launch", "--json"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const doc = parseOnly(r.stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.ok, true);
  const res = doc.result;
  for (const key of ["instance", "agent", "home", "work", "branch", "launched", "warnings", "tmux"]) {
    assert.ok(key in res, `result.${key} present`);
  }
  assert.equal(res.agent, "dev");
  assert.match(res.instance, /^dev-ctr/);
  assert.equal(res.work, "checkout");
  assert.equal(res.launched, false);
  assert.ok(Array.isArray(res.warnings), "warnings is always an array");
  assert.equal(typeof res.tmux.window, "string");
});

test("oas spawn --json failures are one stdout envelope, stable codes, nonzero exit", () => {
  const base = temp(); const { repo } = fixtureSoul(base);
  const env = { ...process.env, PATH: fakeRuntimes(base), PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
  delete env.PI_AGENTS_ROOT;
  const cases = [
    { args: ["spawn", "--json"], code: "E_USAGE" },
    { args: ["spawn", "no-such-agent", "--json"], code: "E_UNKNOWN_AGENT" },
    { args: ["spawn", "dev", "--parent", "ghost-1", "--json"], code: "E_PARENT_NOT_FOUND" },
    { args: ["spawn", "dev", "--task", "--json"], code: "E_BAD_ARGS" }, // --task without value
    { args: ["spawn", "dev", "--task-file", join(base, "missing.md"), "--json"], code: "E_BAD_ARGS" },
  ];
  for (const c of cases) {
    const r = spawnSync(process.execPath, [CLI, ...c.args, "--no-launch"], { cwd: repo, env, encoding: "utf8" });
    assert.notEqual(r.status, 0, `${c.args.join(" ")} exits nonzero`);
    const doc = parseOnly(r.stdout);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.ok, false);
    assert.equal(doc.error.code, c.code, `${c.args.join(" ")} → ${c.code} (got ${doc.error.code}: ${doc.error.message})`);
    assert.equal(typeof doc.error.message, "string");
  }
  // No deployment at all → E_NO_DEPLOYMENT.
  const bare = temp();
  const r = spawnSync(process.execPath, [CLI, "spawn", "dev", "--json", "--dir", bare, "--no-launch"], { cwd: bare, env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.equal(parseOnly(r.stdout).error.code, "E_NO_DEPLOYMENT");
});

test("okf harvest --json: skipped envelope carries a reason", () => {
  const base = temp(); const { root } = fixtureSoul(base);
  // An instance home with no notes → skipped.
  const home = join(root, "dev", "instances", "dev-h1");
  write(join(home, "instance.json"), JSON.stringify({ instance: "dev-h1", agent: "dev" }));
  mkdirSync(join(home, "notes"), { recursive: true });
  const r = spawnSync(process.execPath, [OKF_BIN, "harvest", "--json"], { cwd: home, encoding: "utf8", env: { ...process.env, OAS_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const doc = parseOnly(r.stdout);
  assert.deepEqual(doc, { schemaVersion: 1, ok: true, result: { harvest: "skipped", reason: "no pending notes" } });
});

test("okf harvest --json: spawned envelope carries instance and window", () => {
  const base = temp(); const { repo, root } = fixtureSoul(base);
  // Unique instance name → unique harvester slug/window (tmux windows persist across runs).
  const inst = `dev-h2-${base.slice(-6).replace(/[^a-z0-9]/gi, "")}`.toLowerCase();
  const home = join(root, "dev", "instances", inst);
  const work = join(home, "work"); mkdirSync(work, { recursive: true });
  write(join(home, "instance.json"), JSON.stringify({ instance: inst, agent: "dev", repo, work: "checkout" }));
  write(join(home, "notes", "a-note.md"), "---\ntype: Lesson\n---\n\n# a note\n");
  write(join(home, "soul", "knowledge", "index.md"), "# kb\n");
  mkdirSync(join(home, "soul", "skills"), { recursive: true });
  const env = { ...process.env, PATH: fakeRuntimes(base), OAS_HOME: home, PI_AGENTS_TMUX_SESSION: "oas-test-nosuch" };
  delete env.PI_AGENTS_ROOT;
  const r = spawnSync(process.execPath, [OKF_BIN, "harvest", "--json"], { cwd: home, encoding: "utf8", env });
  const doc = parseOnly(r.stdout);
  assert.equal(doc.schemaVersion, 1);
  if (doc.ok) {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(doc.result.harvest, "spawned");
    assert.match(doc.result.instance, /^memory-harvest-/);
    assert.ok("window" in doc.result);
    // clean up the tmux window the harvest launched
    spawnSync("tmux", ["kill-window", "-t", `oas-test-nosuch:${doc.result.instance}`]);
  } else {
    // Environments without a workable tmux still honor the contract:
    // one failure envelope, stable code, nonzero exit.
    assert.notEqual(r.status, 0);
    assert.equal(doc.error.code, "E_HARVEST_FAILED");
  }
});

// ---- end-to-end capability dispatch: `oas <ns> <cmd> --json` boundary ----
// The generic dispatcher itself must honor the envelope: inactive namespace,
// unknown subcommand, unknown namespace, and malformed instance metadata all
// print exactly one envelope object on stdout with a stable code.

function opsCapability(repo, { commands = { ping: "ping.mjs" } } = {}) {
  const dir = join(repo, ".agents", "capabilities", "owned", "ops");
  write(join(dir, "oas.json"), JSON.stringify({ capability: "acme.ops", command: "ops", version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "Ops.", commands }));
  write(join(dir, "ping.mjs"), "console.log(JSON.stringify({schemaVersion:1,ok:true,result:{pong:true}}))\n");
  return dir;
}

test("capability dispatch --json failures are one stdout envelope with stable codes", () => {
  const base = temp(); const { repo } = fixtureSoul(base);
  opsCapability(repo);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  additive:\n    acme.ops:\n      souls:\n        dev: true\n");
  const envNoHome = { ...process.env, PI_AGENT_HOME: "", OAS_HOME: "" };
  // inactive namespace (not active in this context) → E_CAPABILITY_INACTIVE
  let r = spawnSync(process.execPath, [CLI, "ops", "ping", "--json"], { cwd: repo, encoding: "utf8", env: envNoHome });
  assert.notEqual(r.status, 0);
  assert.equal(parseOnly(r.stdout).error.code, "E_CAPABILITY_INACTIVE");
  // active via instance metadata: unknown subcommand → E_UNKNOWN_COMMAND
  const home = join(base, "instance"); mkdirSync(home);
  write(join(home, "instance.json"), JSON.stringify({ repo, capabilities: [{ id: "acme.ops" }] }));
  const envHome = { ...process.env, PI_AGENT_HOME: home };
  r = spawnSync(process.execPath, [CLI, "ops", "nope", "--json"], { cwd: home, encoding: "utf8", env: envHome });
  assert.notEqual(r.status, 0);
  assert.equal(parseOnly(r.stdout).error.code, "E_UNKNOWN_COMMAND");
  // success passes the child's envelope through untouched
  r = spawnSync(process.execPath, [CLI, "ops", "ping", "--json"], { cwd: home, encoding: "utf8", env: envHome });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseOnly(r.stdout).result, { pong: true });
  // unknown namespace entirely → E_UNKNOWN_COMMAND (help must not hit stdout)
  r = spawnSync(process.execPath, [CLI, "nosuchns", "x", "--json"], { cwd: repo, encoding: "utf8", env: envNoHome });
  assert.notEqual(r.status, 0);
  assert.equal(parseOnly(r.stdout).error.code, "E_UNKNOWN_COMMAND");
  // malformed instance.json → E_CONFIG_BROKEN
  const badHome = join(base, "bad-instance"); mkdirSync(badHome);
  write(join(badHome, "instance.json"), "{not json");
  r = spawnSync(process.execPath, [CLI, "ops", "ping", "--json"], { cwd: badHome, encoding: "utf8", env: { ...process.env, PI_AGENT_HOME: badHome } });
  assert.notEqual(r.status, 0);
  assert.equal(parseOnly(r.stdout).error.code, "E_CONFIG_BROKEN");
});

test("capability dispatch --json: broken manifests and malformed command values still emit one envelope", () => {
  // Reviewer repro 1: an instance whose metadata carries a team snapshot plus
  // a malformed capability oas.json in the context — manifest discovery throws
  // AFTER the metadata try, which previously escaped with empty stdout.
  const base = temp(); const { repo } = fixtureSoul(base);
  opsCapability(repo);
  write(join(repo, "oas-config.yaml"), "name: fixture\n"); // config level so .agents/capabilities is discovered
  write(join(repo, ".agents", "capabilities", "owned", "broken", "oas.json"), "{malformed");
  const home = join(base, "instance"); mkdirSync(home);
  write(join(home, "instance.json"), JSON.stringify({
    repo, capabilities: [{ id: "acme.ops" }],
    team: { name: "t", id: "t1", scope: base }, // team snapshot: metadata parse succeeds
  }));
  const env = { ...process.env, PI_AGENT_HOME: home };
  let r = spawnSync(process.execPath, [CLI, "ops", "ping", "--json"], { cwd: home, encoding: "utf8", env });
  assert.notEqual(r.status, 0);
  const doc1 = parseOnly(r.stdout); // throws if stdout is empty or contaminated
  assert.equal(doc1.ok, false);
  assert.ok(["E_CAPABILITY_BROKEN", "E_CONFIG_BROKEN"].includes(doc1.error.code), doc1.error.code);

  // Reviewer repro 2: a manifest command value that is not a string
  // (commands: { ping: 42 }) — previously crashed at .split() with no envelope.
  const base2 = temp(); const { repo: repo2 } = fixtureSoul(base2);
  const dir = join(repo2, ".agents", "capabilities", "owned", "ops");
  write(join(repo2, "oas-config.yaml"), "name: fixture\n");
  write(join(dir, "oas.json"), JSON.stringify({ capability: "acme.ops", command: "ops", version: "1.0.0", compatibility: { oas: ">=0.6.2" }, description: "Ops.", commands: { ping: 42 } }));
  const home2 = join(base2, "instance"); mkdirSync(home2);
  write(join(home2, "instance.json"), JSON.stringify({ repo: repo2, capabilities: [{ id: "acme.ops" }] }));
  r = spawnSync(process.execPath, [CLI, "ops", "ping", "--json"], { cwd: home2, encoding: "utf8", env: { ...process.env, PI_AGENT_HOME: home2 } });
  assert.notEqual(r.status, 0);
  const doc2 = parseOnly(r.stdout);
  assert.equal(doc2.error.code, "E_CAPABILITY_BROKEN");
  assert.match(doc2.error.message, /non-empty string/);
});

test("oas okf harvest --json end-to-end through the CLI dispatcher", () => {
  const base = temp(); const { repo, root } = fixtureSoul(base);
  // Activate oas.okf as a config-owned capability by pointing an owned package
  // at the real oas-okf sources (owned origin ⇒ trusted without a lock).
  const okfSrc = resolve(new URL("../capabilities/oas-okf", import.meta.url).pathname);
  const owned = join(repo, ".agents", "capabilities", "owned", "oas-okf");
  mkdirSync(dirname(owned), { recursive: true });
  execFileSync("cp", ["-R", okfSrc, owned]);
  write(join(repo, "oas-config.yaml"), "capabilities:\n  layers:\n    knowledge:\n      capability: oas.okf\n");
  const home = join(root, "dev", "instances", "dev-e2e");
  write(join(home, "instance.json"), JSON.stringify({ instance: "dev-e2e", agent: "dev", repo, capabilities: [{ id: "oas.okf" }] }));
  mkdirSync(join(home, "notes"), { recursive: true });
  const env = { ...process.env, PI_AGENT_HOME: home, OAS_HOME: home };
  // no notes → skipped envelope, through `oas okf harvest --json` (exit 0)
  const r = spawnSync(process.execPath, [CLI, "okf", "harvest", "--json"], { cwd: home, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseOnly(r.stdout), { schemaVersion: 1, ok: true, result: { harvest: "skipped", reason: "no pending notes" } });
  // malformed OAS_SETTINGS in the environment → envelope failure, not a stack trace
  const r2 = spawnSync(process.execPath, [OKF_BIN, "harvest", "--json"], { cwd: home, encoding: "utf8", env: { ...env, OAS_SETTINGS: "{broken" } });
  assert.notEqual(r2.status, 0);
  assert.equal(parseOnly(r2.stdout).error.code, "E_HARVEST_FAILED");
});
