// Regression for the phase-2 hook: the desktop must not reuse an OLDER
// installed oas-web that answers /api/panel (workspace covered) but lacks
// the desktop endpoints — /api/brain 404s and Brain looks broken. Reuse
// requires GET /api/version to identify THIS checkout (capability+version
// match against capabilities/oas-web/oas.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverCompatible, selectServer } from "../packages/desktop/server-compat.mjs";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = (() => {
  const m = JSON.parse(readFileSync(join(ROOT, "capabilities", "oas-web", "oas.json"), "utf8"));
  return { capability: m.capability, version: m.version };
})();

test("matching capability+version is compatible (reuse)", () => {
  const r = serverCompatible({ ok: true, status: 200, body: { ...LOCAL } }, LOCAL);
  assert.equal(r.compatible, true);
});

test("404 on /api/version (older oas-web) is incompatible — spawn own server", () => {
  const r = serverCompatible({ ok: false, status: 404, body: { error: "not found" } }, LOCAL);
  assert.equal(r.compatible, false);
  assert.match(r.reason, /older oas-web/);
});

test("network failure, wrong capability, and version mismatch are incompatible", () => {
  assert.equal(serverCompatible(null, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: "other.thing", version: LOCAL.version } }, LOCAL).compatible, false);
  assert.equal(serverCompatible({ ok: true, body: { capability: LOCAL.capability, version: "0.1.0" } }, LOCAL).compatible, false);
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
    assert.match(choice.reason, /older oas-web/);
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

test("REAL oas-web serves /api/version matching its oas.json → reuse through the seam", async (t) => {
  // Boots the actual capabilities/oas-web/bin/oas-web.mjs — removing the
  // /api/version route (or breaking its identity payload) fails THIS test.
  const free = await new Promise((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); });
  });
  const bin = join(ROOT, "capabilities", "oas-web", "bin", "oas-web.mjs");
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
    if (!up) return t.skip("oas-web did not come up (environment)");
    const v = await fetch(`${url}/api/version`);
    assert.equal(v.ok, true, "real /api/version answers");
    assert.deepEqual(await v.json(), LOCAL, "identity matches oas.json");
    const choice = await selectAgainst(url);
    assert.equal(choice.action, "reuse", "the real current server is reused");
  } finally {
    child.kill();
  }
});
