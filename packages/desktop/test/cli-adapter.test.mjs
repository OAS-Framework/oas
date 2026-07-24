// CLI adapter (packages/desktop/cli-adapter.mjs) — Desktop CLI API v1
// mutation path: envelope parsing, argv allowlist, 0600 task tempfiles,
// fixed harvest cwd, and resolve-never-reject domain results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync, existsSync } from "node:fs";
import {
  parseEnvelope, spawnArgv, writeTaskFile, cliSpawn, cliHarvest,
} from "../cli-adapter.mjs";

const OK = (result) => JSON.stringify({ schemaVersion: 1, ok: true, result });
const ERR = (code, message) => JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } });

function fakeExec(handler) {
  return (bin, argv, opts, cb) => {
    const r = handler(bin, argv, opts);
    process.nextTick(() => cb(r.err || null, r.stdout ?? ""));
  };
}

test("parseEnvelope: accepts exactly the two contract shapes, rejects contamination", () => {
  assert.ok(parseEnvelope(OK({ instance: "dev-1" })));
  assert.ok(parseEnvelope(ERR("E_UNKNOWN_AGENT", "nope")));
  assert.equal(parseEnvelope("Spawning...\n" + OK({})), null, "progress prose on stdout is contamination");
  assert.equal(parseEnvelope(JSON.stringify({ ok: true, result: {} })), null, "missing schemaVersion");
  assert.equal(parseEnvelope(JSON.stringify({ schemaVersion: 1, ok: true })), null, "ok without result");
  assert.equal(parseEnvelope(JSON.stringify({ schemaVersion: 1, ok: false })), null, "failure without error");
  assert.equal(parseEnvelope(""), null);
});

test("spawnArgv: allowlisted args only — unknown renderer keys are dropped, never forwarded", () => {
  const argv = spawnArgv("dev", "/ws", "/tmp/t/TASK.md", {
    purpose: "fix", repo: "/r", work: "worktree", runtime: "pi", model: "opus",
    parent: "evil-1",             // NOT allowlisted (operator-origin spawns only)
    "--task": "injection",        // junk keys dropped
    branch: "sneaky",             // not in the v1 allowlist
  });
  assert.deepEqual(argv, [
    "spawn", "dev", "--dir", "/ws", "--task-file", "/tmp/t/TASK.md",
    "--purpose", "fix", "--repo", "/r", "--work", "worktree",
    "--runtime", "pi", "--model", "opus", "--json",
  ]);
  assert.ok(!argv.includes("evil-1") && !argv.includes("sneaky") && !argv.includes("injection"));
});

test("spawnArgv: option-shaped values are REJECTED, never forwarded (review 53a20c7)", () => {
  // The CLI parser scans raw argv with includes()/indexOf() — an
  // option-shaped VALUE would inject a real non-allowlisted token.
  for (const opts of [
    { purpose: "--no-launch" },
    { repo: "--task-file" },
    { model: "-x" },
    { work: "--json" },          // also fails the enum
    { runtime: "claude; rm" },   // fails the enum
    { purpose: "a b" },          // fails the slug
  ]) {
    assert.throws(() => spawnArgv("dev", "/ws", "/t/TASK.md", opts), /invalid/, JSON.stringify(opts));
  }
  assert.throws(() => spawnArgv("--evil", "/ws", "/t/TASK.md", {}), /invalid agent name/);
});

test("cliSpawn: option-shaped values resolve as E_BAD_ARGS envelopes (never reach the CLI)", async () => {
  let execCalled = false;
  const exec = fakeExec(() => { execCalled = true; return { stdout: OK({}) }; });
  const env = await cliSpawn("/abs/oas", { agent: "dev", workspaceDir: "/ws", purpose: "--no-launch" }, { exec });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_BAD_ARGS");
  assert.equal(execCalled, false, "the CLI is never invoked with a rejected value");
});

test("writeTaskFile: file is 0600 from creation and cleanup removes the private dir", () => {
  const { file, cleanup } = writeTaskFile("secret task\n");
  try {
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `task file mode ${mode.toString(8)} must be 600`);
    assert.equal(readFileSync(file, "utf8"), "secret task\n");
  } finally { cleanup(); }
  assert.ok(!existsSync(file), "cleanup removed the tempdir");
});

test("writeTaskFile: mode is set at open (wx + 0600), not chmod-after", () => {
  // Injected io proves the flags/mode reach openSync — a chmod-after
  // implementation has a readable window and fails this.
  let opened = null;
  const io = {
    mkdtempSync: () => "/fake-tmp",
    openSync: (path, flags, mode) => { opened = { path, flags, mode }; return 7; },
    writeSync: () => {},
    closeSync: () => {},
    rmSync: () => {},
    tmpdir: () => "/fake",
  };
  writeTaskFile("x", io).cleanup();
  assert.equal(opened.flags, "wx", "create-exclusive");
  assert.equal(opened.mode, 0o600, "owner-only at open");
});


test("cliSpawn: success envelope resolves with result; task file cleaned up after", async () => {
  let seen = null;
  const exec = fakeExec((bin, argv, opts) => {
    seen = { bin, argv, opts };
    const taskFile = argv[argv.indexOf("--task-file") + 1];
    assert.ok(existsSync(taskFile), "task file exists while the CLI runs");
    assert.equal(readFileSync(taskFile, "utf8"), "do the thing");
    return { stdout: OK({ instance: "dev-x1", agent: "dev", home: "/h", work: "worktree", branch: "b", launched: true, warnings: [], tmux: { session: "pi-agents", window: "dev-x1" } }) };
  });
  const env = await cliSpawn("/abs/oas", { agent: "dev", workspaceDir: "/ws", task: "do the thing", purpose: "x1" }, { exec });
  assert.equal(env.ok, true);
  assert.equal(env.result.instance, "dev-x1");
  assert.equal(seen.bin, "/abs/oas", "discovered absolute binary");
  assert.equal(seen.opts.shell, false, "never a shell");
  assert.equal(seen.opts.cwd, "/ws");
  const taskFile = seen.argv[seen.argv.indexOf("--task-file") + 1];
  assert.ok(!existsSync(taskFile), "task tempfile removed after the call");
});

test("cliSpawn: CLI failure envelope resolves (never rejects) with the stable code", async () => {
  const exec = fakeExec(() => ({ err: Object.assign(new Error("exit 1"), { code: 1 }), stdout: ERR("E_UNKNOWN_AGENT", 'unknown agent "nope"') }));
  const env = await cliSpawn("/abs/oas", { agent: "nope", workspaceDir: "/ws", task: "" }, { exec });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "E_UNKNOWN_AGENT");
});

test("cliSpawn: contaminated stdout resolves with E_CLI_PROTOCOL; timeout with E_CLI_TIMEOUT", async () => {
  const contaminated = fakeExec(() => ({ stdout: "Spawning dev...\n" + OK({}) }));
  let env = await cliSpawn("/abs/oas", { agent: "dev", workspaceDir: "/ws" }, { exec: contaminated });
  assert.equal(env.error.code, "E_CLI_PROTOCOL");
  const timedOut = fakeExec(() => ({ err: Object.assign(new Error("timeout"), { killed: true }), stdout: "" }));
  env = await cliSpawn("/abs/oas", { agent: "dev", workspaceDir: "/ws" }, { exec: timedOut });
  assert.equal(env.error.code, "E_CLI_TIMEOUT");
});

test("cliHarvest: runs `okf harvest --json` with cwd fixed to the given instance home", async () => {
  let seen = null;
  const exec = fakeExec((bin, argv, opts) => {
    seen = { bin, argv, opts };
    return { stdout: OK({ harvest: "skipped", reason: "no pending notes" }) };
  });
  const env = await cliHarvest("/abs/oas", "/homes/dev-1", { exec });
  assert.equal(env.ok, true);
  assert.equal(env.result.harvest, "skipped");
  assert.deepEqual(seen.argv, ["okf", "harvest", "--json"]);
  assert.equal(seen.opts.cwd, "/homes/dev-1", "cwd is the resolved instance home");
  assert.equal(seen.opts.shell, false);
});
