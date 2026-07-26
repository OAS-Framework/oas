import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CAPABILITY = join(ROOT, "capabilities", "oas-aweb");
const HOOK = join(CAPABILITY, "bin", "oas-aweb.mjs");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "oas-aweb-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakePath(t, body = "exit 97") {
  const bin = join(tempDir(t), "bin");
  mkdirSync(bin);
  const aw = join(bin, "aw");
  writeFileSync(aw, `#!/bin/sh\n${body}\n`);
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

test("all declared skill paths resolve inside package-owned node_modules", () => {
  const manifest = JSON.parse(readFileSync(join(CAPABILITY, "oas.json"), "utf8"));
  const dependencyRoot = realpathSync(join(CAPABILITY, "node_modules"));
  assert.equal(manifest.skills.length, 3);
  for (const skill of manifest.skills) {
    assert.match(skill, /^node_modules\/@awebai\/pi\/skills\//);
    const resolvedSkill = realpathSync(join(CAPABILITY, skill, "SKILL.md"));
    assert.ok(resolvedSkill.startsWith(dependencyRoot + sep), `${skill} resolved outside package-owned node_modules`);
  }
});

test("checked lock pins the aweb skill dependency", () => {
  const lock = JSON.parse(readFileSync(join(CAPABILITY, "package-lock.json"), "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[""].dependencies["@awebai/pi"], "^0.2.1");
  assert.ok(lock.packages["node_modules/@awebai/pi"].integrity);
});

test("materialized closure keeps aweb pi 0.2.x and omits its coding-agent peer", () => {
  const pi = JSON.parse(readFileSync(join(CAPABILITY, "node_modules", "@awebai", "pi", "package.json"), "utf8"));
  assert.match(pi.version, /^0\.2\./);
  assert.equal(existsSync(join(CAPABILITY, "node_modules", "@earendil-works", "pi-coding-agent")), false);
});

test("declared commands and hooks do not import the omitted peer", () => {
  const manifest = JSON.parse(readFileSync(join(CAPABILITY, "oas.json"), "utf8"));
  const commands = [...Object.values(manifest.commands || {}), ...Object.values(manifest.hooks || {})];
  const entrypoints = new Set(commands.map((command) => command.trim().split(/\s+/)[0]));
  assert.ok(entrypoints.size > 0);
  for (const entrypoint of entrypoints) {
    const source = readFileSync(join(CAPABILITY, entrypoint), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-coding-agent/);
  }
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

test("roster guidance uses the required --to recipient flag", async (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, ".aw"));
  const result = await run(["roster"], {
    PATH: fakePath(t, `printf '%s\\n' '{"team_id":"default:test","members":[]}'`),
    OAS_EVENT: "roster",
    OAS_HOME: root,
    OAS_TEAM_SCOPE: root,
    OAS_TEAM_ID: "default:test",
  }, root);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /aw mail send --to <alias>/);
  assert.doesNotMatch(result.stdout, /aw mail send <alias>/);
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
