// Desktop renderer views — integration-boundary regressions (no DOM needed).
// Guards the seams the harness masks: module naming the shell imports, the
// theme.css fallback URL, the ctx.api dual-shape seam, and the harness
// proxy's origin guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = join(ROOT, "packages", "desktop", "renderer");

test("views ship as .mjs with mount/unmount (shell imports ./views/<name>.mjs)", () => {
  for (const name of ["instances", "spawn", "jira"]) {
    const f = join(RENDERER, "views", `${name}.mjs`);
    assert.ok(existsSync(f), `${name}.mjs missing`);
    const src = readFileSync(f, "utf8");
    assert.match(src, /export function mount\(/, `${name}: no mount export`);
    assert.match(src, /export function unmount\(/, `${name}: no unmount export`);
    assert.match(src, /from "\.\/common\.mjs"/, `${name}: must import common.mjs`);
  }
});

test("theme fallback URL resolves from views/ to renderer/theme.css", () => {
  const src = readFileSync(join(RENDERER, "views", "common.mjs"), "utf8");
  const m = src.match(/new URL\("([^"]+)", import\.meta\.url\)/);
  assert.ok(m, "ensureTheme must resolve theme.css via import.meta.url");
  const resolved = join(RENDERER, "views", m[1]);
  assert.ok(existsSync(resolved), `theme URL "${m[1]}" resolves to a missing file: ${resolved}`);
});

test("apiJson accepts both a Fetch Response and shell-parsed JSON", async () => {
  const { apiJson } = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  // Response-shaped (harness): ok → parsed body; !ok → throws server error.
  const asResponse = (ok, status, body) => ({ ok, status, json: async () => body });
  assert.deepEqual(await apiJson({ api: async () => asResponse(true, 200, { a: 1 }) }, "/api/panel"), { a: 1 });
  await assert.rejects(apiJson({ api: async () => asResponse(false, 409, { error: "nope" }) }, "/api/spawn"), /nope/);
  // Shell-shaped: ctx.api resolves already-parsed data (and throws itself on non-2xx).
  assert.deepEqual(await apiJson({ api: async () => ({ agents: [] }) }, "/api/agents"), { agents: [] });
});

test("harness proxy: 403s hostile Host/Origin without reaching upstream; forwards the real Origin on loopback requests", async () => {
  const { createHarnessServer } = await import(new URL("../packages/desktop/renderer/harness-server.mjs", import.meta.url).href);
  // fake upstream: records what actually reaches it
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({ path: req.url, origin: req.headers.origin ?? null, host: req.headers.host });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const upPort = upstream.address().port;
  const harness = createHarnessServer(new URL(`http://127.0.0.1:${upPort}`));
  await new Promise((ok) => harness.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${harness.address().port}`;
  // fetch() strips forbidden headers like Host, so drive raw HTTP for forgeries
  const raw = (path, { method = "GET", headers = {} } = {}) => new Promise((ok, err) => {
    const q = httpRequest({ hostname: "127.0.0.1", port: harness.address().port, path, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => b += c); res.on("end", () => ok({ status: res.statusCode, body: b }));
    });
    q.on("error", err); q.end();
  });
  try {
    // hostile Host: 403, upstream never sees it
    let r = await raw("/api/panel", { headers: { host: "evil.example" } });
    assert.equal(r.status, 403);
    // hostile Origin on a mutating request: 403, upstream never sees it
    r = await raw("/api/spawn", { method: "POST", headers: { host: "127.0.0.1", origin: "http://evil.example" } });
    assert.equal(r.status, 403);
    // malformed Origin: 403
    r = await raw("/api/panel", { headers: { host: "127.0.0.1", origin: "null" } });
    assert.equal(r.status, 403);
    assert.equal(seen.length, 0, "hostile requests must never reach upstream");
    // loopback request: proxied, with the browser's ORIGINAL Origin unchanged
    const myOrigin = base; // a loopback origin, but NOT the upstream's authority
    const r2 = await fetch(`${base}/api/panel?x=1`, { headers: { origin: myOrigin } });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { ok: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/api/panel?x=1");
    assert.equal(seen[0].origin, myOrigin, "the real Origin must be forwarded, never rewritten");
    assert.equal(seen[0].host, `127.0.0.1:${upPort}`, "Host is rewritten for routing only");
    // loopback request WITHOUT an Origin header stays origin-less upstream
    const r3 = await fetch(`${base}/api/agents`);
    assert.equal(r3.status, 200);
    assert.equal(seen[1].origin, null, "no Origin must not be invented");
  } finally {
    harness.close();
    upstream.close();
  }
});

test("per-instance requests are workspace-scoped: same-named instance in two workspaces never resolves across the selected one", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  // Fake oas-web with TWO workspaces each owning an instance named "dev-1",
  // honoring ?ws= the way the real server's findInstance(name, wsId) does:
  // scoped lookup only in that workspace, strict 404 on unknown ws.
  const byWs = { wsA: { "dev-1": "A" }, wsB: { "dev-1": "B" } };
  const interrupted = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const m = url.pathname.match(/^\/api\/(interrupt|chat|jira)\/([^/]+)$/);
    const ws = url.searchParams.get("ws");
    const ok = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const notFound = () => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unknown instance" })); };
    if (!m) return notFound();
    const owner = ws ? byWs[ws]?.[m[2]] : Object.values(byWs).find((w) => w[m[2]])?.[m[2]]; // unscoped = global (the hazard)
    if (!owner) return notFound();
    if (m[1] === "interrupt") { interrupted.push(owner); return ok({ sent: true }); }
    return ok({ owner });
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const ctx = { api: (pathname, opts) => fetch(base + pathname, opts) };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsB");
    // the path builder itself pins the selected workspace on every kind
    for (const kind of ["interrupt", "chat", "jira", "session", "keys"]) {
      const p = common.instanceApiPath(kind, "dev-1");
      assert.match(p, new RegExp(`^/api/${kind}/dev-1\\?ws=wsB$`), `${kind} must carry the selected ws`);
    }
    assert.equal(common.instanceApiPath("chat", "dev-1", "limit=150"), "/api/chat/dev-1?limit=150&ws=wsB");
    // MUTATING request viewed from wsB lands on wsB's instance — never wsA's
    await common.postJson(ctx, common.instanceApiPath("interrupt", "dev-1"), {});
    assert.deepEqual(interrupted, ["B"], "interrupt must resolve only inside the selected workspace");
    // reads scope identically
    assert.deepEqual(await common.apiJson(ctx, common.instanceApiPath("jira", "dev-1")), { owner: "B" });
    // an instance that exists only in the OTHER workspace is a strict miss
    common.setWorkspace("wsC");
    await assert.rejects(common.postJson(ctx, common.instanceApiPath("interrupt", "dev-1"), {}), /unknown instance/);
    assert.deepEqual(interrupted, ["B"], "no cross-workspace interrupt leaked");
  } finally {
    common.setWorkspace(prevWs);
    upstream.close();
  }
});
