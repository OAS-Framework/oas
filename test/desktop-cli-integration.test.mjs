// Desktop server ↔ CLI integration: discovery status endpoint, re-probe,
// and the two v1 mutations routed through a FAKE compatible `oas` binary
// (the repo CLI is intentionally pre-0.18 until tag-driven CI bumps it, so
// acceptance is exercised with a fixture that speaks the exact contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRV = join(ROOT, "packages", "desktop", "server", "oas-web.mjs");

/** A fake `oas` that speaks Desktop CLI API v1 exactly. It logs its argv/cwd
 * so assertions can verify the adapter's invocation shape. */
function fakeCli(dir, { version = "0.18.0", desktopApi = 1 } = {}) {
  const log = join(dir, "cli-calls.jsonl");
  const js = join(dir, "oas.cjs");
  const bin = join(dir, "oas");
  writeFileSync(js, `const { appendFileSync, readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
if (argv[0] === "version" && argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, name: "@oas-framework/oas", version: ${JSON.stringify(version)}, desktopApi: ${JSON.stringify(desktopApi)} }));
  process.exit(0);
}
if (argv[0] === "spawn" && argv.includes("--json")) {
  const agent = argv[1];
  const tf = argv[argv.indexOf("--task-file") + 1];
  const task = readFileSync(tf, "utf8");
  if (agent === "boom") { process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_SPAWN_FAILED", message: "boom" } })); process.exit(1); }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: {
    instance: agent + "-t1", agent, home: "/tmp/h", work: "worktree", branch: "b",
    launched: true, warnings: [], tmux: { session: "pi-agents", window: agent + "-t1" },
    taskEcho: task } }));
  process.exit(0);
}
if (argv[0] === "okf" && argv[1] === "harvest" && argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, result: { harvest: "skipped", reason: "no pending notes" } }));
  process.exit(0);
}
process.stderr.write("unexpected argv: " + argv.join(" "));
process.exit(2);
`);
  // PATH is intentionally hostile in these tests (/nonexistent), so the
  // launcher must not rely on env lookup: absolute node, absolute script.
  writeFileSync(bin, `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"
`);
  chmodSync(bin, 0o755);
  // The locator canonicalizes candidates (realpath) — on macOS /var →
  // /private/var — so assertions compare against the canonical path.
  return { bin, real: realpathSync(bin), calls: () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

async function startServer(env) {
  const port = 4300 + Math.floor(Math.random() * 1500);
  const proc = spawn(process.execPath, [SRV, "start", "--port", String(port), "--dir", ROOT],
    { stdio: "ignore", env: { ...process.env, ...env } });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { await fetch(`http://127.0.0.1:${port}/api/panel`); return { proc, port }; } catch { /* retry */ }
  }
  proc.kill();
  throw new Error("server did not come up");
}

test("desktop server: /api/cli reports discovery status; compatible fake CLI accepted via OAS_DESKTOP_OAS_BIN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oas-clifake-"));
  const { bin, real } = fakeCli(dir);
  const { proc, port } = await startServer({ OAS_DESKTOP_OAS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    // startup probe may still be running — reprobe deterministically
    const s = await (await fetch(`http://127.0.0.1:${port}/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.version, "0.18.0");
    assert.equal(s.source, "env");
    assert.deepEqual(s.required, { desktopApi: 1, range: ">=0.18.0 <0.19.0" });
    const g = await (await fetch(`http://127.0.0.1:${port}/api/cli`)).json();
    assert.equal(g.ok, true);
    assert.equal(g.bin, real);
  } finally { proc.kill(); }
});

test("desktop server: incompatible CLI → status carries per-candidate diagnostics; spawn degrades 503", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oas-cliold-"));
  const { bin, real } = fakeCli(dir, { version: "0.17.6" });
  const { proc, port } = await startServer({ OAS_DESKTOP_OAS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    const s = await (await fetch(`http://127.0.0.1:${port}/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(s.ok, false);
    const envTried = s.tried.find((t) => t.path === real);
    assert.ok(envTried, "the rejected candidate is in diagnostics");
    assert.match(envTried.reason, /outside/);
    assert.equal(envTried.version, "0.17.6", "detected version surfaces for the card");
    // mutation degrades with the stable code — reads keep working
    const ad = await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json();
    assert.ok(Array.isArray(ad.agents) && ad.agents.length, "reads still work without a compatible CLI");
    const r = await fetch(`http://127.0.0.1:${port}/api/spawn`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: ad.agents[0].name, agentsRoot: ad.agents[0].agentsRoot }) });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "cli-unavailable");
  } finally { proc.kill(); }
});

test("desktop server: spawn routes through the CLI with --dir/--task-file argv; harvest fixes cwd to the instance home", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oas-climut-"));
  const { bin, calls } = fakeCli(dir);
  const { proc, port } = await startServer({ OAS_DESKTOP_OAS_BIN: bin, PATH: "/nonexistent", SHELL: "/bin/false" });
  try {
    await fetch(`http://127.0.0.1:${port}/api/cli/reprobe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const ad = await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json();
    const agent = ad.agents[0];
    // ---- spawn
    const r = await fetch(`http://127.0.0.1:${port}/api/spawn`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: agent.name, agentsRoot: agent.agentsRoot, task: "secret task text", purpose: "t1" }) });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    const body = await r.json();
    assert.equal(body.spawned, true);
    assert.equal(body.instance, `${agent.name}-t1`);
    assert.ok(Array.isArray(body.warnings));
    assert.ok(body.tmux && body.tmux.window, "tmux target present (contract result field)");
    const spawnCall = calls().find((c) => c.argv[0] === "spawn");
    assert.ok(spawnCall, "CLI spawn invoked");
    assert.equal(spawnCall.argv[1], agent.name);
    assert.equal(spawnCall.argv[spawnCall.argv.indexOf("--dir") + 1], dirname(agent.agentsRoot), "--dir is the workspace context");
    assert.ok(spawnCall.argv.includes("--task-file"), "task travels by 0600 tempfile, never argv");
    assert.ok(!spawnCall.argv.includes("secret task text"), "task text NEVER in argv");
    assert.equal(spawnCall.argv[spawnCall.argv.indexOf("--purpose") + 1], "t1");
    // ---- spawn failure envelope → 409 with the CLI's stable code
    const rf = await fetch(`http://127.0.0.1:${port}/api/spawn`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "boom", agentsRoot: agent.agentsRoot }) });
    // "boom" is not a real soul in this repo — unknown agent (409) is also
    // acceptable; the point is a stable non-2xx with an error body.
    assert.ok([409, 502].includes(rf.status), `spawn failure surfaces (${rf.status})`);
    // ---- harvest: pick a real instance from the panel and check cwd
    const pd = await (await fetch(`http://127.0.0.1:${port}/api/panel`)).json();
    const inst = pd.instances.find((i) => i.home);
    if (inst) {
      const hr = await fetch(`http://127.0.0.1:${port}/api/harvest/${encodeURIComponent(inst.instance)}?ws=${encodeURIComponent(pd.workspace.id)}`, { method: "POST" });
      assert.equal(hr.status, 200, JSON.stringify(await hr.clone().json()));
      const hb = await hr.json();
      assert.equal(hb.harvest, "skipped");
      const harvestCall = calls().find((c) => c.argv[0] === "okf");
      assert.deepEqual(harvestCall.argv, ["okf", "harvest", "--json"]);
      assert.equal(harvestCall.cwd, inst.home, "cwd fixed by the backend to the RESOLVED instance home");
    }
    // unknown instance → 404, CLI never invoked for it
    const h404 = await fetch(`http://127.0.0.1:${port}/api/harvest/no-such-instance`, { method: "POST" });
    assert.equal(h404.status, 404);
  } finally { proc.kill(); }
});
