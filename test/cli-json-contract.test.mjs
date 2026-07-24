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
