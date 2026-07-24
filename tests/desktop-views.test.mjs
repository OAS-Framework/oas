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
  // Fake backend with TWO workspaces each owning an instance named "dev-1",
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

test("jira guard: a deferred response from the previous workspace never paints after a switch + same-name reselect", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { refreshJira } = await import(new URL("../packages/desktop/renderer/views/instances.mjs", import.meta.url).href);
  // ctx.api resolves on demand so the test controls response ORDER exactly.
  const gate = [];
  const ctx = { api: (pathname) => new Promise((ok) => gate.push({ pathname, ok })) };
  const payload = (ws) => ({ ok: true, status: 200, json: async () => ({ enabled: true, label: `from-${ws}` }) });
  const s = { alive: true, sel: "dev-1", jiraReq: 0, jira: null, lastChatSig: "x", lastChatData: null, ctx };
  const prevWs = common.currentWorkspace();
  try {
    // 1. viewing wsB: jira fetch for dev-1 goes out (in flight)
    common.setWorkspace("wsB");
    const inFlightB = refreshJira(s, "dev-1");
    assert.match(gate[0].pathname, /ws=wsB/);
    // 2. user switches to wsA and reselects the SAME instance name — the view
    //    bumps jiraReq (clearSelection/select do this) and refetches
    common.setWorkspace("wsA");
    s.jiraReq++;
    const inFlightA = refreshJira(s, "dev-1");
    assert.match(gate[1].pathname, /ws=wsA/);
    // 3. wsA's response lands first and paints
    gate[1].ok(payload("wsA"));
    await inFlightA;
    assert.equal(s.jira.label, "from-wsA");
    // 4. wsB's STALE response finally lands — name matches (dev-1 === dev-1),
    //    but the generation token must reject it
    gate[0].ok(payload("wsB"));
    await inFlightB;
    assert.equal(s.jira.label, "from-wsA", "stale cross-workspace jira response must never paint");
  } finally {
    common.setWorkspace(prevWs);
  }
});

test("ws generation: deferred roster/agents responses from workspace A never paint after switching to B", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { refresh } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const gate = [];
  const payload = (body) => ({ ok: true, status: 200, json: async () => body });
  const ctx = { api: (pathname) => new Promise((ok) => gate.push({ pathname, ok })) };
  const painted = [];
  // renderList/renderWorkspaceSelect touch the DOM; stub the minimum and
  // observe paints via s.souls
  const fakeEl = () => ({ style: {}, dataset: {}, classList: { toggle() {}, add() {} }, innerHTML: "", textContent: "", title: "",
                          appendChild() {}, querySelectorAll: () => [], addEventListener() {} });
  const hadDoc = Object.prototype.hasOwnProperty.call(globalThis, "document");
  if (!hadDoc) globalThis.document = { createElement: fakeEl };
  const s = {
    alive: true, ctx, souls: { agents: [] }, filterText: "",
    q: () => fakeEl(),
  };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    const inFlightA = refresh(s);            // /api/agents + /api/panel for wsA in flight
    assert.match(gate[0].pathname, /ws=wsA/);
    common.setWorkspace("wsB");              // switch bumps the generation
    const inFlightB = refresh(s);
    assert.match(gate[2].pathname, /ws=wsB/);
    // wsB's responses land and paint
    gate[2].ok(payload({ agents: [{ name: "from-B" }] }));
    gate[3].ok(payload({ workspaces: [], workspace: { id: "wsB" }, instances: [] }));
    await inFlightB;
    assert.equal(s.souls.agents[0].name, "from-B");
    // wsA's STALE responses land late — they must not overwrite wsB's list
    gate[0].ok(payload({ agents: [{ name: "from-A" }] }));
    gate[1].ok(payload({ workspaces: [], workspace: { id: "wsA" }, instances: [] }));
    await inFlightA;
    assert.equal(s.souls.agents[0].name, "from-B", "stale workspace-A agents must never paint after switching to B");
  } finally {
    common.setWorkspace(prevWs);
    if (!hadDoc) delete globalThis.document;
  }
});

test("ws generation: a spawn begun in workspace A completing after a switch to B never auto-opens the terminal", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const opened = [];
  let release;
  const panelWith = (names) => ({ ok: true, status: 200, json: async () => ({ instances: names.map((n) => ({ instance: n })) }) });
  const ctx = {
    api: (pathname) => pathname.startsWith("/api/panel")
      ? Promise.resolve(panelWith(["dev-1"]))          // roster already caught up
      : new Promise((ok) => { release = () => ok({ ok: true, status: 200, json: async () => ({ instance: "dev-1", launched: true }) }); }),
    openTerminal: (name) => opened.push(name),
  };
  const fields = { ftask: { value: "t" }, fpurpose: { value: "" }, fspawn: { disabled: false, textContent: "" }, fstatus: { textContent: "" } };
  const s = { ctx, selAgent: { name: "dev", agentsRoot: "/a" }, q: (cls) => fields[cls], spawnOp: 0, waitOpts: { delayMs: 0, tries: 3 } };
  const prevWs = common.currentWorkspace();
  try {
    // in-flight spawn survives a workspace switch: must NOT auto-open
    common.setWorkspace("wsA");
    const inFlight = doSpawn(s);
    common.setWorkspace("wsB");              // user switches while spawning
    release();
    await inFlight;
    assert.deepEqual(opened, [], "openTerminal(dev-1) with wsB current would target a same-named B instance");
    assert.match(fields.fstatus.textContent, /previous workspace/);
    // control: same flow without a switch DOES auto-open
    const p2 = doSpawn(s);
    release();
    await p2;
    assert.deepEqual(opened, ["dev-1"]);
  } finally {
    common.setWorkspace(prevWs);
  }
});

test("spawn op token: a stale workspace-A spawn completing during an in-flight B spawn never touches B's form", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const opened = [];
  const releases = [];
  const respond = (instance) => ({ ok: true, status: 200, json: async () => ({ instance, launched: true }) });
  const ctx = {
    api: (pathname) => pathname.startsWith("/api/panel")
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ instances: [{ instance: "inst-A" }, { instance: "inst-B" }] }) })
      : new Promise((ok) => releases.push(ok)),
    openTerminal: (name) => opened.push(name),
  };
  const fields = { ftask: { value: "task-A" }, fpurpose: { value: "" }, fspawn: { disabled: false, textContent: "" }, fstatus: { textContent: "" } };
  const s = { ctx, selAgent: { name: "dev", agentsRoot: "/a" }, q: (cls) => fields[cls], spawnOp: 0, waitOpts: { delayMs: 0, tries: 3 } };
  const prevWs = common.currentWorkspace();
  try {
    // spawn 1 dispatched in wsA
    common.setWorkspace("wsA");
    const spawnA = doSpawn(s);
    // user switches to wsB, fills the SAME form for a B agent, spawns again
    common.setWorkspace("wsB");
    fields.ftask.value = "task-B"; fields.fstatus.textContent = "";
    s.selAgent = { name: "dev-b", agentsRoot: "/b" };
    const spawnB = doSpawn(s);
    assert.equal(fields.fspawn.disabled, true, "B's spawn is in flight — button disabled");
    // A's STALE completion lands while B is still in flight
    releases[0](respond("inst-A"));
    await spawnA;
    assert.equal(fields.ftask.value, "task-B", "stale A completion must not clear B's task field");
    assert.equal(fields.fstatus.textContent, "", "stale A completion must not overwrite B's status");
    assert.equal(fields.fspawn.disabled, true, "stale A completion must not re-enable the button mid-B-spawn (duplicate-spawn hazard)");
    assert.deepEqual(opened, [], "stale A completion must not open a terminal");
    // B completes normally: owns the form, clears it, auto-opens
    releases[1](respond("inst-B"));
    await spawnB;
    assert.equal(fields.ftask.value, "");
    assert.match(fields.fstatus.textContent, /Spawned inst-B/);
    assert.equal(fields.fspawn.disabled, false);
    assert.deepEqual(opened, ["inst-B"]);
  } finally {
    common.setWorkspace(prevWs);
  }
});

test("spawn op token: a stale spawn ERROR never overwrites the active spawn's status or button", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const releases = [];
  const ctx = {
    api: (pathname) => pathname.startsWith("/api/panel") ? Promise.resolve({ ok: true, status: 200, json: async () => ({ instances: [{ instance: "inst-2" }] }) }) : new Promise((ok, err) => releases.push({ ok, err })),
    openTerminal: () => {},
  };
  const fields = { ftask: { value: "" }, fpurpose: { value: "" }, fspawn: { disabled: false, textContent: "" }, fstatus: { textContent: "" } };
  const s = { ctx, selAgent: { name: "dev", agentsRoot: "/a" }, q: (cls) => fields[cls], spawnOp: 0, waitOpts: { delayMs: 0, tries: 3 } };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    const spawn1 = doSpawn(s);
    const spawn2 = doSpawn(s);             // supersedes spawn1 on the same form
    releases[0].err(new Error("boom"));    // spawn1 fails LATE
    await spawn1;
    assert.equal(fields.fstatus.textContent, "", "stale error must not paint over the active spawn's status");
    assert.equal(fields.fspawn.disabled, true, "stale error's finally must not re-enable the in-flight button");
    releases[1].ok({ ok: true, status: 200, json: async () => ({ instance: "inst-2", launched: false }) });
    await spawn2;
    assert.match(fields.fstatus.textContent, /Spawned inst-2/);
    assert.equal(fields.fspawn.disabled, false);
  } finally {
    common.setWorkspace(prevWs);
  }
});

test("stale snapshot: spawn waits for the instance to appear in /api/panel before auto-opening the terminal", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const opened = [];
  let panelCalls = 0;
  const panel = (names) => ({ ok: true, status: 200, json: async () => ({ instances: names.map((n) => ({ instance: n })) }) });
  const ctx = {
    // background snapshot lags: first two polls miss the new instance, third has it
    api: (pathname) => pathname.startsWith("/api/panel")
      ? Promise.resolve(panel(++panelCalls >= 3 ? ["old-1", "dev-new"] : ["old-1"]))
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-new", launched: true }) }),
    openTerminal: (name) => opened.push(name),
  };
  const fields = { ftask: { value: "" }, fpurpose: { value: "" }, fspawn: { disabled: false, textContent: "" }, fstatus: { textContent: "" } };
  const s = { ctx, selAgent: { name: "dev", agentsRoot: "/a" }, q: (cls) => fields[cls], spawnOp: 0, waitOpts: { delayMs: 0, tries: 10 } };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    await doSpawn(s);
    assert.equal(panelCalls, 3, "must poll until the snapshot includes the new instance");
    assert.deepEqual(opened, ["dev-new"], "auto-open fires only after the roster knows the instance");
  } finally {
    common.setWorkspace(prevWs);
  }
});

test("stale snapshot: if the roster never catches up, spawn reports instead of opening an unresolvable terminal", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const opened = [];
  const ctx = {
    api: (pathname) => pathname.startsWith("/api/panel")
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ instances: [{ instance: "old-1" }] }) })
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-new", launched: true }) }),
    openTerminal: (name) => opened.push(name),
  };
  const fields = { ftask: { value: "" }, fpurpose: { value: "" }, fspawn: { disabled: false, textContent: "" }, fstatus: { textContent: "" } };
  const s = { ctx, selAgent: { name: "dev", agentsRoot: "/a" }, q: (cls) => fields[cls], spawnOp: 0, waitOpts: { delayMs: 0, tries: 3 } };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    await doSpawn(s);
    assert.deepEqual(opened, [], "never call openTerminal with an instance the roster cannot resolve");
    assert.match(fields.fstatus.textContent, /catching up/, "user is told where to find the instance");
    assert.equal(fields.fspawn.disabled, false, "button unlocks after the wait gives up");
  } finally {
    common.setWorkspace(prevWs);
  }
});

test("stale snapshot: a workspace switch during the roster wait aborts the auto-open", async () => {
  const common = await import(new URL("../packages/desktop/renderer/views/common.mjs", import.meta.url).href);
  const { doSpawn } = await import(new URL("../packages/desktop/renderer/views/spawn.mjs", import.meta.url).href);
  const opened = [];
  let panelCalls = 0;
  const ctx = {
    api: (pathname) => {
      if (!pathname.startsWith("/api/panel"))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ instance: "dev-new", launched: true }) });
      panelCalls++;
      if (panelCalls === 2) common.setWorkspace("wsB"); // switch mid-wait
      // the instance only appears AFTER the switch has happened
      const names = panelCalls >= 3 ? [{ instance: "dev-new" }] : [];
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ instances: names }) });
    },
    openTerminal: (name) => opened.push(name),
  };
  const fields = { ftask: { value: "" }, fpurpose: { value: "" }, fspawn: { disabled: false, textContent: "" }, fstatus: { textContent: "" } };
  const s = { ctx, selAgent: { name: "dev", agentsRoot: "/a" }, q: (cls) => fields[cls], spawnOp: 0, waitOpts: { delayMs: 0, tries: 5 } };
  const prevWs = common.currentWorkspace();
  try {
    common.setWorkspace("wsA");
    await doSpawn(s);
    assert.deepEqual(opened, [], "ws switched during the wait: opening now would resolve in the wrong workspace");
  } finally {
    common.setWorkspace(prevWs);
  }
});
