// Regression for the phase-2 hook: the desktop must not reuse an OLDER
// installed server that answers /api/panel (workspace covered) but lacks
// the desktop endpoints — /api/brain 404s and Brain looks broken. Reuse
// requires GET /api/version to identify THIS checkout (capability+version
// match against packages/desktop/package.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverCompatible, selectServer, ensureServerOnPort } from "../packages/desktop/server-compat.mjs";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = (() => {
  const m = JSON.parse(readFileSync(join(ROOT, "packages", "desktop", "package.json"), "utf8"));
  return { capability: m.name, version: m.version };
})();

test("matching capability+version is compatible (reuse)", () => {
  const r = serverCompatible({ ok: true, status: 200, body: { ...LOCAL } }, LOCAL);
  assert.equal(r.compatible, true);
});

test("404 on /api/version (older server) is incompatible — spawn own server", () => {
  const r = serverCompatible({ ok: false, status: 404, body: { error: "not found" } }, LOCAL);
  assert.equal(r.compatible, false);
  assert.match(r.reason, /older server/);
});

test("network failure, wrong capability, and version mismatch are incompatible", () => {
  assert.equal(serverCompatible(null, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: "other.thing", version: LOCAL.version } }, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: LOCAL.capability, version: "0.0.0-other" } }, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: null }, LOCAL).compatible, false);
});

// End-to-end through the PRODUCTION seam (selectServer, exactly what
// ensureServer runs) against fake servers — re-implementing the decision in
// the test would leave the real gate unprotected (review srvcompat).
async function selectAgainst(url, matchWorkspace = (ws) => ws[0]?.id || null) {
  const panelWorkspaces = async () => {
    try {
      const r = await fetch(`${url}/api/panel`);
      return r.ok ? (await r.json()).workspaces || [] : null;
    } catch { return null; }
  };
  const probeVersion = async () => {
    try {
      const r = await fetch(`${url}/api/version`);
      let body = null; try { body = await r.json(); } catch { /* non-JSON */ }
      return { ok: r.ok, status: r.status, body };
    } catch { return null; }
  };
  return selectServer({ panelWorkspaces, probeVersion, matchWorkspace, local: LOCAL });
}

test("fake older server: /api/panel answers, /api/version 404s → selectServer says spawn", async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith("/api/panel")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workspaces: [{ id: "/tmp/ws", name: "ws" }], instances: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`);
    assert.equal(choice.action, "spawn", "older server must not be reused");
    assert.match(choice.reason, /older server/);
  } finally { server.close(); }
});

test("fake matching server → selectServer says reuse with the matched workspace", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/api/panel")) {
      res.end(JSON.stringify({ workspaces: [{ id: "/tmp/ws", name: "ws" }], instances: [] }));
    } else if (req.url.startsWith("/api/version")) {
      res.end(JSON.stringify({ capability: LOCAL.capability, version: LOCAL.version }));
    } else { res.end("{}"); }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(choice, { action: "reuse", wsId: "/tmp/ws" });
  } finally { server.close(); }
});

test("no server on the port → spawn", async () => {
  const choice = await selectAgainst("http://127.0.0.1:1"); // nothing listens
  assert.equal(choice.action, "spawn");
  assert.equal(choice.portOccupied, false, "no listener — caller keeps the port");
});

test("spawn decisions carry the portOccupied discriminator (not reason strings)", async () => {
  // review srvcompat2 nit: port selection must key on an explicit flag, so a
  // wording change in reason can never alter behavior.
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    req.url.startsWith("/api/panel")
      ? res.end(JSON.stringify({ workspaces: [{ id: "/other", name: "other" }], instances: [] }))
      : res.end("{}");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const choice = await selectAgainst(`http://127.0.0.1:${server.address().port}`, () => null); // no workspace match
    assert.equal(choice.action, "spawn");
    assert.equal(choice.portOccupied, true, "occupied port — caller must move");
  } finally { server.close(); }
});

// ensureServerOnPort: the CONSUMER of the discriminator (review srvcompat3 —
// proving the emitter is not enough; review srvcompat4 — the decision is
// INJECTED with arbitrary reason text so a consumer keying on any reason
// wording, e.g. the old `reason !== "no server on the port"`, fails these).
function ensureIo(choice, port, calls) {
  return {
    select: async () => choice,   // arbitrary decision, arbitrary wording
    port,
    freePort: async (from) => { calls.push(["freePort", from]); return from + 7; },
    spawnServer: (p) => calls.push(["spawn", p]),
    log: () => {},
  };
}

test("ensureServerOnPort: occupied decision moves ports and spawns there — regardless of reason text", async () => {
  // Reason text deliberately says the magic free-port phrase: a consumer
  // comparing reason strings would keep the port; the discriminator moves it.
  const calls = [];
  const r = await ensureServerOnPort(ensureIo({ action: "spawn", portOccupied: true, reason: "no server on the port" }, 4820, calls));
  assert.deepEqual(calls, [["freePort", 4821], ["spawn", 4828]], "moved off the occupied port before spawning");
  assert.deepEqual(r, { spawned: true, port: 4828, wsId: null });
});

test("ensureServerOnPort: free port spawns in place (no freePort call) — regardless of reason text", async () => {
  // Inverse trap: an occupied-sounding reason on a free-port decision.
  const calls = [];
  const r = await ensureServerOnPort(ensureIo({ action: "spawn", portOccupied: false, reason: "incompatible (wording trap)" }, 4820, calls));
  assert.deepEqual(calls, [["spawn", 4820]], "kept the free port");
  assert.equal(r.port, 4820);
});

test("ensureServerOnPort: reuse neither spawns nor moves", async () => {
  const calls = [];
  const r = await ensureServerOnPort(ensureIo({ action: "reuse", wsId: "/w" }, 4820, calls));
  assert.deepEqual(calls, [], "no effects on reuse");
  assert.deepEqual(r, { spawned: false, port: 4820, wsId: "/w" });
});

test("ensureServerOnPort defaults to the real selectServer when no select is injected", async () => {
  // Keeps the production wiring covered: end-to-end against a fake matching
  // server through the DEFAULT selection path.
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    req.url.startsWith("/api/panel")
      ? res.end(JSON.stringify({ workspaces: [{ id: "/w", name: "w" }], instances: [] }))
      : res.end(JSON.stringify({ capability: LOCAL.capability, version: LOCAL.version }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  try {
    const r = await ensureServerOnPort({
      panelWorkspaces: async () => (await (await fetch(`${url}/api/panel`)).json()).workspaces,
      probeVersion: async () => { const v = await fetch(`${url}/api/version`); return { ok: v.ok, status: v.status, body: await v.json() }; },
      matchWorkspace: (ws) => ws[0]?.id || null,
      local: LOCAL,
      port: 4820,
      freePort: async (from) => { calls.push(["freePort", from]); return from; },
      spawnServer: (p) => calls.push(["spawn", p]),
    });
    assert.deepEqual(r, { spawned: false, port: 4820, wsId: "/w" }, "real selection path reuses the matching server");
    assert.deepEqual(calls, []);
  } finally { server.close(); }
});

test("REAL bundled server serves /api/version matching its package identity → reuse through the seam", async (t) => {
  // Boots the actual packages/desktop/server/oas-web.mjs — removing the
  // /api/version route (or breaking its identity payload) fails THIS test.
  const free = await new Promise((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); });
  });
  const bin = join(ROOT, "packages", "desktop", "server", "oas-web.mjs");
  const child = spawn(process.execPath, [bin, "start", "--port", String(free), "--dir", ROOT], { stdio: ["ignore", "pipe", "pipe"] });
  const url = `http://127.0.0.1:${free}`;
  try {
    // wait for the server to answer (max ~10s) — readiness via /api/panel,
    // NOT /api/version: the route under test must not gate the skip, or
    // removing it would skip this test instead of failing it.
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { up = (await fetch(`${url}/api/panel`, { signal: AbortSignal.timeout(500) })).ok; }
      catch { await new Promise((ok) => setTimeout(ok, 250)); }
    }
    if (!up) return t.skip("server did not come up (environment)");
    const v = await fetch(`${url}/api/version`);
    assert.equal(v.ok, true, "real /api/version answers");
    assert.deepEqual(await v.json(), LOCAL, "identity matches the desktop package");
    const choice = await selectAgainst(url);
    assert.equal(choice.action, "reuse", "the real current server is reused");
  } finally {
    child.kill();
  }
});
