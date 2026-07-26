import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOOK = join(ROOT, "bin", "oas-aweb.mjs");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "oas-aweb-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakePath(t) {
  const bin = join(tempDir(t), "bin");
  mkdirSync(bin);
  const aw = join(bin, "aw");
  writeFileSync(aw, "#!/bin/sh\nexit 97\n");
  chmodSync(aw, 0o755);
  return bin;
}

function run(args = [], env = {}, cwd = ROOT) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [HOOK, ...args], {
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

test("all declared skills resolve from package-owned node_modules", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "oas.json"), "utf8"));
  assert.equal(manifest.skills.length, 3);
  for (const skill of manifest.skills) {
    assert.match(skill, /^node_modules\/@awebai\/pi\/skills\//);
    assert.equal(existsSync(join(ROOT, skill, "SKILL.md")), true, `${skill} was not materialized`);
  }
});

test("checked lock pins the aweb skill dependency", () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[""].dependencies["@awebai/pi"], "^0.2.1");
  assert.ok(lock.packages["node_modules/@awebai/pi"].integrity);
});

test("spawn degrades cleanly when aw is absent", async (t) => {
  const home = tempDir(t);
  const result = await run(["spawn"], {
    PATH: tempDir(t),
    OAS_EVENT: "spawn",
    OAS_HOME: home,
    OAS_INSTANCE: "developer-api-1",
  }, home);
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).warning, /aw CLI not on PATH/);
});

test("authority discovery does not walk above the workspace", async (t) => {
  const outer = tempDir(t);
  const workspace = join(outer, "workspace");
  const home = join(workspace, "agents", "example", "instances", "example-1");
  mkdirSync(join(outer, ".aw"));
  mkdirSync(home, { recursive: true });
  const result = await run(["spawn"], {
    PATH: fakePath(t),
    OAS_EVENT: "spawn",
    OAS_HOME: home,
    OAS_INSTANCE: "example-1",
    OAS_CONTEXT: workspace,
    OAS_WORKSPACE: workspace,
    OAS_TEAM_SCOPE: workspace,
  }, home);
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).warning, /no initialized aweb root/);
});

test("retire without persisted identity is an idempotent no-op", async (t) => {
  const home = tempDir(t);
  const result = await run(["retire"], {
    PATH: fakePath(t),
    OAS_EVENT: "retire",
    OAS_HOME: home,
    OAS_META: "{}",
  }, home);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { meta: { retired: false } });
});
