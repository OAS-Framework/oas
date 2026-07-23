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
import { serverCompatible } from "../packages/desktop/server-compat.mjs";

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

test("fake older server: /api/panel answers, /api/version 404s → incompatible end-to-end", async () => {
  // Simulates the real-world trigger (an older installed panel on the port):
  // workspace probe passes, version probe 404s — the desktop must decide to
  // spawn its own server instead of reusing.
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
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const panel = await fetch(`${url}/api/panel`);
    assert.equal(panel.ok, true, "older server passes the workspace probe");
    const v = await fetch(`${url}/api/version`);
    let body = null; try { body = await v.json(); } catch { /* ignore */ }
    const r = serverCompatible({ ok: v.ok, status: v.status, body }, LOCAL);
    assert.equal(r.compatible, false, "…but must NOT be reused");
  } finally {
    server.close();
  }
});

test("fake current server: /api/version matches local oas.json → reuse", async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith("/api/version")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capability: LOCAL.capability, version: LOCAL.version }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const v = await fetch(`${url}/api/version`);
    const r = serverCompatible({ ok: v.ok, status: v.status, body: await v.json() }, LOCAL);
    assert.equal(r.compatible, true);
  } finally {
    server.close();
  }
});
