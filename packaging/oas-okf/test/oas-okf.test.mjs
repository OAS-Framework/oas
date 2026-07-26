import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
