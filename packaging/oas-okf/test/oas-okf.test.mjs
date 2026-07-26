import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(ROOT, "capabilities", "oas-okf", "bin", "oas-okf.mjs");

function run(args = [], env = {}, cwd = ROOT) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "oas-okf-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeOasPath(t) {
  const bin = join(tempDir(t), "bin");
  mkdirSync(bin);
  const script = join(bin, "oas");
  writeFileSync(script, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const taskFile = args[args.indexOf("--task-file") + 1];
fs.writeFileSync(process.env.OAS_TEST_RECORD, JSON.stringify({
  args,
  taskFile,
  task: fs.readFileSync(taskFile, "utf8"),
  taskMode: fs.statSync(taskFile).mode & 0o777,
}));
if (process.env.OAS_TEST_ERROR_CODE) {
  console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: process.env.OAS_TEST_ERROR_CODE, message: "synthetic spawn failure" } }));
  process.exit(1);
}
const purpose = args[args.indexOf("--purpose") + 1];
const instance = \`memory-harvest-\${purpose}\`;
console.log(JSON.stringify({ schemaVersion: 1, ok: true, result: {
  instance,
  agent: "memory-harvest",
  home: "/synthetic/home",
  work: args[args.indexOf("--work") + 1],
  tmux: { window: instance },
} }));
`);
  chmodSync(script, 0o755);
  return bin;
}

function harvestFixture(t, mode, { model, errorCode } = {}) {
  const scope = tempDir(t);
  const root = join(scope, "agents");
  const home = join(root, "source", "instances", "source-instance-1");
  const context = join(scope, "context");
  const work = join(home, "work");
  mkdirSync(join(home, "notes"), { recursive: true });
  mkdirSync(context, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, "notes", "pending.md"), "---\ntype: Lesson\n---\n\nPending.\n");

  let soul = join(home, "soul");
  if (mode === "workspace") {
    const soulRepo = join(scope, "soul-repo");
    mkdirSync(join(soulRepo, ".git"), { recursive: true });
    soul = join(soulRepo, "agents", "source", "soul");
  }
  mkdirSync(soul, { recursive: true });

  const record = join(scope, "spawn-record.json");
  return {
    home,
    context,
    soul,
    record,
    env: {
      OAS_EVENT: "harvest",
      OAS_HOME: home,
      OAS_ROOT: root,
      OAS_INSTANCE: "source-instance-1",
      OAS_AGENT: "source",
      OAS_SOUL: soul,
      OAS_CONTEXT: context,
      OAS_KIND: mode === "local" ? "local" : "persistent",
      OAS_WORK: mode === "workspace" ? "workspace" : "worktree",
      OAS_SETTINGS: JSON.stringify(model ? { "harvest-model": model } : {}),
      OAS_TEST_RECORD: record,
      ...(errorCode ? { OAS_TEST_ERROR_CODE: errorCode } : {}),
      PATH: `${fakeOasPath(t)}:${process.env.PATH}`,
    },
  };
}

const argValue = (args, flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

test("soul-scaffold creates an idempotent OKF bundle", async (t) => {
  const dir = tempDir(t);
  const soul = join(dir, "soul");
  const env = { OAS_EVENT: "soul-scaffold", OAS_SOUL: soul, OAS_AGENT: "test-agent", OAS_SETTINGS: "{}" };
  const first = await run(["soul-scaffold"], env);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { meta: { scaffolded: true } });
  assert.match(readFileSync(join(soul, "knowledge", "index.md"), "utf8"), /okf_version: "0.1"/);
  assert.match(readFileSync(join(soul, "knowledge", "log.md"), "utf8"), /knowledge bundle scaffolded/);

  const second = await run(["soul-scaffold"], env);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { meta: { scaffolded: true } });
});

test("spawn creates persistent-instance continuity files", async (t) => {
  const home = tempDir(t);
  const result = await run(["spawn"], {
    OAS_EVENT: "spawn",
    OAS_HOME: home,
    OAS_INSTANCE: "test-agent-1",
    OAS_AGENT: "test-agent",
    OAS_KIND: "persistent",
    OAS_TASK: "Exercise the package hook.",
    OAS_REPO: "/tmp/example",
    OAS_BRANCH: "test",
    OAS_WORK: "worktree",
    OAS_SETTINGS: "{}",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).meta.memory, "okf");
  for (const path of ["STATE.md", "log.md", "notes"]) assert.equal(existsSync(join(home, path)), true, `${path} was not scaffolded`);
  assert.match(readFileSync(join(home, "STATE.md"), "utf8"), /Exercise the package hook/);
});

test("harvest implementation uses no private kernel-file boundary", () => {
  const source = readFileSync(CLI, "utf8");
  assert.doesNotMatch(source, /lib\/core\.mjs/);
  assert.doesNotMatch(source, /oas root/);
  assert.doesNotMatch(source, /pathToFileURL|resolveOasConfig|spawnInstance/);
  assert.match(source, /spawnSync\("oas"/);
});

test("manifest exports the packaged ephemeral memory-harvest agent", () => {
  const capability = join(ROOT, "capabilities", "oas-okf");
  const manifest = JSON.parse(readFileSync(join(capability, "oas.json"), "utf8"));
  assert.deepEqual(manifest.agents, ["agents/memory-harvest"]);
  const soul = readFileSync(join(capability, manifest.agents[0], "soul.yaml"), "utf8");
  assert.match(soul, /^name: memory-harvest$/m);
  assert.match(soul, /^kind: capability$/m);
  assert.match(soul, /^work: attached$/m);
  assert.match(readFileSync(join(capability, manifest.agents[0], "AGENTS.md"), "utf8"), /Follow the \*\*memory-harvest\*\* skill.*load it before/s);
});

test("spawn leaves capability agents ephemeral", async (t) => {
  const home = tempDir(t);
  const result = await run(["spawn"], {
    OAS_EVENT: "spawn",
    OAS_HOME: home,
    OAS_INSTANCE: "memory-harvest-test",
    OAS_KIND: "capability",
    OAS_SETTINGS: "{}",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).meta.memory, "none");
  assert.equal(existsSync(join(home, "STATE.md")), false);
});

test("harvest skips without notes before requiring the runtime boundary", async (t) => {
  const home = tempDir(t);
  const result = await run(["harvest", "--json"], { OAS_HOME: home, OAS_SETTINGS: "{}" }, home);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: true,
    result: { harvest: "skipped", reason: "no pending notes" },
  });
});

test("local-soul harvest spawns attached through the CLI boundary with effective settings", async (t) => {
  const fixture = harvestFixture(t, "local", { model: "test-provider/harvest-model" });
  const result = await run(["harvest", "--json"], fixture.env, fixture.home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.instance, "memory-harvest-source-instance-1");
  const record = JSON.parse(readFileSync(fixture.record, "utf8"));
  assert.deepEqual(record.args.slice(0, 2), ["spawn", "memory-harvest"]);
  assert.equal(argValue(record.args, "--purpose"), "source-instance-1");
  assert.equal(argValue(record.args, "--parent"), "source-instance-1");
  assert.equal(argValue(record.args, "--repo"), fixture.context);
  assert.equal(argValue(record.args, "--work"), "attached");
  assert.equal(argValue(record.args, "--work-dir"), realpathSync(join(fixture.home, "work")));
  assert.equal(argValue(record.args, "--model"), "test-provider/harvest-model");
  assert.equal(record.taskMode, 0o600);
  assert.match(record.task, /LOCAL-SOUL/);
  assert.equal(record.args.at(-1), "--json");
  assert.equal(existsSync(record.taskFile), false, "task tempfile must be removed after spawn");
});

test("workspace harvest builds a dedicated worktree spawn with the default model", async (t) => {
  const fixture = harvestFixture(t, "workspace");
  const result = await run(["harvest", "--json"], fixture.env, fixture.home);
  assert.equal(result.code, 0, result.stderr);
  const record = JSON.parse(readFileSync(fixture.record, "utf8"));
  const soulRepo = realpathSync(resolve(fixture.soul, "..", "..", ".."));
  assert.equal(argValue(record.args, "--repo"), soulRepo);
  assert.equal(argValue(record.args, "--work"), "worktree");
  assert.equal(argValue(record.args, "--branch"), "memory-harvest/source-instance-1");
  assert.equal(argValue(record.args, "--model"), "github-copilot/gpt-5.5");
  assert.equal(record.args.includes("--work-dir"), false);
  assert.match(record.task, /WORKSPACE-MODE/);
  assert.equal(record.taskMode, 0o600);
  assert.equal(existsSync(record.taskFile), false);
});

test("repo-resident harvest builds an attached same-tree spawn", async (t) => {
  const fixture = harvestFixture(t, "repo");
  const result = await run(["harvest", "--json"], fixture.env, fixture.home);
  assert.equal(result.code, 0, result.stderr);
  const record = JSON.parse(readFileSync(fixture.record, "utf8"));
  assert.equal(argValue(record.args, "--repo"), fixture.context);
  assert.equal(argValue(record.args, "--work"), "attached");
  assert.equal(argValue(record.args, "--work-dir"), realpathSync(join(fixture.home, "work")));
  assert.equal(argValue(record.args, "--branch"), undefined);
  assert.match(record.task, /ATTACHED to the instance's work tree/);
  assert.equal(record.taskMode, 0o600);
  assert.equal(existsSync(record.taskFile), false);
});

test("harvest propagates schema-v1 spawn errors and still removes the task file", async (t) => {
  const fixture = harvestFixture(t, "local", { errorCode: "E_PARENT_NOT_FOUND" });
  const result = await run(["harvest", "--json"], fixture.env, fixture.home);
  assert.equal(result.code, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "E_PARENT_NOT_FOUND");
  const record = JSON.parse(readFileSync(fixture.record, "utf8"));
  assert.equal(record.taskMode, 0o600);
  assert.equal(existsSync(record.taskFile), false);
});
