// CLI degradation card + Spawn-view disable behavior (desktop-dist contract:
// without a compatible oas CLI, reads work, mutation UI is consistently
// disabled behind ONE card with detected/required/Choose/Retry/docs/install).
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const cs = await import("../renderer/views/cli-status.mjs");

function dom() {
  const d = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" });
  return d.window.document;
}
const payload = (ok, extra = {}) => ({
  ok, bin: ok ? "/usr/local/bin/oas" : null, version: ok ? "0.18.0" : null,
  source: ok ? "path" : null, required: { desktopApi: 1, range: ">=0.18.0 <0.19.0" },
  probedAt: 1, tried: ok ? [] : [{ path: "/old/oas", source: "path", reason: "version 0.17.6 outside >=0.18.0 <0.19.0", version: "0.17.6" }],
  ...extra,
});
const jsonCtx = (state) => ({
  api: async (pathname, opts) => ({
    ok: true, status: 200,
    json: async () => (pathname === "/api/cli" ? state.get : (state.reprobes.push(opts?.body || null), state.post)),
  }),
});

test("cli-status: a RECEIVED 404 (absent endpoint) settles as unavailable and cards; transport failure stays transient (review 6b90702)", async () => {
  // Older backend: /api/cli does not exist → the endpoint 404s. That is a
  // SETTLED absent-endpoint state and must card from pristine state.
  cs.resetCliStateForTests();
  const notFoundCtx = { api: async () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }) };
  await cs.refreshCli(notFoundCtx);
  assert.equal(cs.cliAvailable(), false);
  assert.equal(cs.cliKnownUnavailable(), true, "404 settles → recovery card shows (absent endpoint case)");
  // shell-proxy shape: api() throws a status-tagged Error on non-2xx — same settling
  cs.resetCliStateForTests();
  const proxy404Ctx = { api: async () => { const e = new Error("HTTP 404 for /api/cli"); e.status = 404; throw e; } };
  await cs.refreshCli(proxy404Ctx);
  assert.equal(cs.cliKnownUnavailable(), true, "status-tagged proxy error settles too");
  // TRANSPORT failure (no status tag) from pristine state: stays pending —
  // no card, and mutations stay disabled (fail-closed).
  cs.resetCliStateForTests();
  const downCtx = { api: async () => { throw new Error("fetch failed: ECONNREFUSED"); } };
  await cs.refreshCli(downCtx);
  assert.equal(cs.cliStatus(), null);
  assert.equal(cs.cliKnownUnavailable(), false, "transport failure is transient — not carded");
  assert.equal(cs.cliAvailable(), false, "but mutations stay disabled (fail-closed)");
  // and a transport failure AFTER a settled state keeps that state (no flapping)
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  assert.equal(cs.cliKnownUnavailable(), true);
  await cs.refreshCli(downCtx);
  assert.equal(cs.cliKnownUnavailable(), true, "settled state survives a transient blip");
});

test("refreshCli/reprobeCli update shared state and notify subscribers", async () => {
  const state = { get: payload(false), post: payload(true), reprobes: [] };
  const ctx = jsonCtx(state);
  const seen = [];
  const off = cs.onCliChange((s) => seen.push(s?.ok));
  await cs.refreshCli(ctx);
  assert.equal(cs.cliAvailable(), false);
  await cs.reprobeCli(ctx);
  assert.equal(cs.cliAvailable(), true);
  assert.deepEqual(seen, [false, true]);
  off();
});

test("reprobeCli forwards a chosen binary path in the body", async () => {
  const state = { get: payload(false), post: payload(true), reprobes: [] };
  await cs.reprobeCli(jsonCtx(state), "/chosen/oas");
  assert.equal(state.reprobes.length, 1);
  assert.match(String(state.reprobes[0]), /\/chosen\/oas/);
});

test("cliCard renders the full contract surface: detected, required, Choose, Retry, docs, copyable install", async () => {
  const doc = dom();
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  let chosen = 0, opened = null;
  const ctx = {
    ...jsonCtx(state),
    chooseCliBinary: async () => { chosen++; return { path: "/picked/oas" }; },
    openExternal: (url) => { opened = url; },
  };
  const { el, dispose } = cs.cliCard(doc, ctx);
  doc.body.append(el);
  // detected path + version from diagnostics
  assert.ok(el.textContent.includes("/old/oas"), "detected path shown");
  assert.ok(el.textContent.includes("0.17.6"), "detected version shown");
  // required range + api
  assert.ok(el.textContent.includes(">=0.18.0 <0.19.0"), "required range shown");
  // copyable install command
  assert.ok(el.querySelector(".cli-cmd").textContent.includes("npm install -g @oas-framework/oas@0.18.0"));
  assert.ok(el.querySelector(".cli-copy"), "copy affordance present");
  // actions
  const choose = el.querySelector(".cli-choose");
  const retry = el.querySelector(".cli-retry");
  assert.ok(choose && !choose.disabled, "Choose oas… enabled when the picker hook exists");
  assert.ok(retry, "Retry present");
  // docs link opens externally, never navigates the shell
  el.querySelector(".cli-docs").dispatchEvent(new doc.defaultView.Event("click", { bubbles: true, cancelable: true }));
  assert.equal(opened, cs.DOCS_URL);
  // choose runs the picker then reprobes with the picked path
  choose.dispatchEvent(new doc.defaultView.Event("click"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(chosen, 1);
  assert.ok(state.reprobes.some((b) => String(b).includes("/picked/oas")), "picked path reprobed");
  dispose();
});

test("cliCard without a picker hook disables Choose but keeps Retry/docs usable", async () => {
  const doc = dom();
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  const { el, dispose } = cs.cliCard(doc, jsonCtx(state));
  assert.equal(el.querySelector(".cli-choose").disabled, true);
  assert.ok(!el.querySelector(".cli-retry").disabled);
  dispose();
});

test("cli-status: a cached unavailable state transitions to UNKNOWN on an invalid/legacy payload (review d7becaf)", async () => {
  // unavailable → legacy/garbage response → unknown → mutation UI ENABLED
  const state = { get: payload(false), post: payload(false), reprobes: [] };
  await cs.refreshCli(jsonCtx(state));
  assert.equal(cs.cliAvailable(), false);
  assert.ok(cs.cliStatus(), "unavailable state cached");
  state.get = { some: "legacy-shape" };            // older server: no boolean ok
  await cs.refreshCli(jsonCtx(state));
  assert.equal(cs.cliStatus(), null, "invalid payload transitions to unknown — stale unavailable NOT kept");
  assert.equal(cs.cliAvailable(), false, "unknown is not 'available' — it is uncommitted");
});

test("spawn view: PENDING probe disables card-less; SETTLED unknown/unavailable always shows the recovery card (binding UX)", async () => {
  const doc = dom();
  globalThis.document = doc;
  try {
    const sp = await import("../renderer/views/spawn.mjs");
    const agents = [{ name: "dev", description: "d", kind: "persistent", work: "worktree", runtime: "pi", repo: "/r", repoName: "r", agentsRoot: "/ws/agents", workspace: "/ws" }];
    // /api/cli HANGS first (probe pending), then answers legacy garbage
    // (settled unknown), then unavailable, then compatible.
    const state = { mode: "pending", posts: [], cliWaiters: [] };
    const ctx = {
      api: (pathname, opts) => {
        if (pathname === "/api/cli" && state.mode === "pending") {
          return new Promise((ok) => state.cliWaiters.push(ok)); // never settles while pending
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => {
            if (pathname.startsWith("/api/agents")) return { workspace: { id: "/ws", name: "ws" }, agents };
            if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws", name: "ws" }, workspaces: [{ id: "/ws", name: "ws" }], instances: [] };
            if (pathname === "/api/cli") return state.mode === "legacy" ? { legacy: true } : state.mode === "bad" ? payload(false) : payload(true);
            if (pathname === "/api/spawn") { state.posts.push(opts); return { spawned: true, instance: "dev-x" }; }
            return {};
          },
        });
      },
      openTerminal: () => {}, openBrain: () => {},
    };
    // reset shared state to truly-pending: a hanging refresh keeps cli null
    cs.resetCliStateForTests();
    const el = doc.createElement("div"); doc.body.append(el);
    sp.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // TRANSIENT probe-pending: disabled, card-less is acceptable
    const spawnBtn = el.querySelector(".spawn-act");
    assert.ok(spawnBtn, "spawn button renders");
    assert.equal(spawnBtn.disabled, true, "pending probe disables spawn (mutations need a VERIFIED CLI)");
    spawnBtn.dispatchEvent(new doc.defaultView.Event("click"));
    assert.equal(el.querySelector(".soul-form"), null, "no form opens while pending");
    // SETTLED unknown (legacy/malformed payload) → card MUST appear
    state.mode = "legacy";
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "settled unknown shows the recovery card (binding UX)");
    assert.ok([...el.querySelectorAll(".spawn-act")].every((b) => b.disabled), "spawn stays disabled");
    // SETTLED unavailable → card stays, still disabled
    state.mode = "bad";
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "known-unavailable keeps the card");
    assert.equal(state.posts.length, 0, "no spawn was ever dispatched");
    // recovery: a compatible probe re-enables and opens forms again
    state.mode = "good";
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 0, "card clears on recovery");
    const btn2 = el.querySelector(".spawn-act");
    assert.ok(btn2 && !btn2.disabled, "verified CLI re-enables spawn");
    btn2.dispatchEvent(new doc.defaultView.Event("click"));
    assert.ok(el.querySelector(".soul-form"), "form opens once the CLI is verified");
    sp.unmount();
    state.cliWaiters.forEach((ok) => ok({ ok: false, status: 599, json: async () => ({}) })); // release hangs
  } finally {
    delete globalThis.document;
  }
});


test("spawn view: form open under a VERIFIED CLI closes on the unavailable transition; a retained stale submit cannot dispatch (review 0b83988)", async () => {
  const doc = dom();
  globalThis.document = doc;
  try {
    const sp = await import("../renderer/views/spawn.mjs");
    const agents = [{ name: "dev", description: "d", kind: "persistent", work: "worktree", runtime: "pi", repo: "/r", repoName: "r", agentsRoot: "/ws/agents", workspace: "/ws" }];
    const state = { cliPayload: payload(true), posts: [] };
    const ctx = {
      api: async (pathname, opts) => ({
        ok: true, status: 200,
        json: async () => {
          if (pathname.startsWith("/api/agents")) return { workspace: { id: "/ws", name: "ws" }, agents };
          if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws", name: "ws" }, workspaces: [{ id: "/ws", name: "ws" }], instances: [] };
          if (pathname === "/api/cli") return state.cliPayload;
          if (pathname === "/api/spawn") { state.posts.push(opts); return { spawned: true, instance: "dev-x", launched: false }; }
          return {};
        },
      }),
      openTerminal: () => {}, openBrain: () => {},
    };
    cs.resetCliStateForTests();
    await cs.refreshCli(ctx);                     // VERIFIED
    const el = doc.createElement("div"); doc.body.append(el);
    sp.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // open the form under a verified CLI — legitimately
    el.querySelector(".spawn-act").dispatchEvent(new doc.defaultView.Event("click"));
    const form = el.querySelector(".soul-form");
    assert.ok(form, "form opens under a verified CLI");
    // RETAIN the stale submit before the transition — its click listener
    // stays live on the detached node, exactly like a queued user click.
    const staleSubmit = form.querySelector(".fspawn");
    assert.ok(staleSubmit, "submit button captured");
    // CLI flips to unavailable → the form-preservation bypass must repaint
    state.cliPayload = payload(false);
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelector(".soul-form"), null, "open form removed on the unavailable transition (bypass, review d7becaf)");
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "card painted");
    // fire the RETAINED (now-detached) submit — the listener still runs;
    // only the doSpawn submit-time gate stops the dispatch.
    staleSubmit.dispatchEvent(new doc.defaultView.Event("click"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(state.posts.length, 0, "stale submit path never dispatched /api/spawn (doSpawn gate)");
    // control: the SAME stale handle DOES dispatch once re-verified —
    // proving the gate (not node detachment) is what blocked it. Restore
    // the selection the transition cleared, as doSpawn reads s.selAgent.
    state.cliPayload = payload(true);
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    el.querySelector(".spawn-act").dispatchEvent(new doc.defaultView.Event("click")); // reselect (fresh form)
    staleSubmit.dispatchEvent(new doc.defaultView.Event("click"));                    // STALE handle fires
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(state.posts.length, 1, "control: the stale handle dispatches when verified — the gate was the blocker");
    sp.unmount();
  } finally {
    delete globalThis.document;
  }
});

test("doSpawn gate isolation: selection still set + CLI unavailable → no dispatch (review 0b83988)", async () => {
  // The realistic race the render-time bypass cannot cover: the CLI flips
  // unavailable but the view listener has not yet repainted (or a stale
  // closure retains the old state object with selAgent SET). Only the
  // doSpawn submit-time gate blocks the POST here — deleting the gate
  // makes this test dispatch.
  const doc = dom();
  globalThis.document = doc;
  try {
    const sp = await import("../renderer/views/spawn.mjs");
    const posts = [];
    const ctx = {
      api: async (pathname, opts) => ({
        ok: true, status: 200,
        json: async () => {
          if (pathname === "/api/spawn") { posts.push(opts); return { spawned: true, instance: "dev-x" }; }
          if (pathname === "/api/cli") return payload(false);           // KNOWN unavailable
          if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws" }, workspaces: [], instances: [] };
          return {};
        },
      }),
      openTerminal: () => {},
    };
    cs.resetCliStateForTests();
    await cs.refreshCli(ctx);                                           // settled unavailable
    assert.equal(cs.cliAvailable(), false);
    // fabricated state exactly as a stale closure would hold it: selection SET
    const grid = doc.createElement("div"); grid.className = "souls-grid"; doc.body.append(grid);
    const s = {
      ctx, alive: true, spawnOp: 0, sel: "dev", filterText: "",
      selAgent: { name: "dev", agentsRoot: "/ws/agents" },
      souls: { agents: [] },
      q: () => grid,
      waitOpts: { tries: 1, delayMs: 1, sleep: async () => {} },
    };
    const btn = doc.createElement("button");
    const status = doc.createElement("span");
    await sp.doSpawn(s, { btn, status, task: () => "t", purpose: () => "", clear: () => {} });
    assert.equal(posts.length, 0, "submit-time gate blocked the dispatch despite a live selection");
    assert.equal(s.sel, null, "gate invalidates the stale selection");
    // control: same fabricated state dispatches once the CLI is verified
    s.sel = "dev"; s.selAgent = { name: "dev", agentsRoot: "/ws/agents" };
    const okCtx = { ...ctx, api: async (pathname, opts) => ({ ok: true, status: 200, json: async () => {
      if (pathname === "/api/spawn") { posts.push(opts); return { spawned: true, instance: "dev-x" }; }
      if (pathname === "/api/cli") return payload(true);
      if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws" }, workspaces: [], instances: [{ instance: "dev-x" }] };
      return {};
    } }) };
    s.ctx = okCtx;
    await cs.refreshCli(okCtx);
    await sp.doSpawn(s, { btn, status, task: () => "t", purpose: () => "", clear: () => {} });
    assert.equal(posts.length, 1, "control: gate open under a verified CLI — the gate was the blocker");
  } finally {
    delete globalThis.document;
  }
});

test("spawn view: no compatible CLI disables every spawn button and shows ONE card; reads stay rendered", async () => {
  const doc = dom();
  globalThis.document = doc; // spawn.mjs builds DOM via the global document
  try {
    const sp = await import("../renderer/views/spawn.mjs");
    const state = { get: payload(false), post: payload(false), reprobes: [] };
    const agents = [
      { name: "dev", description: "a dev", kind: "persistent", work: "worktree", runtime: "pi", repo: "/r", repoName: "r", agentsRoot: "/ws/agents", workspace: "/ws" },
      { name: "helper", description: "cap", kind: "capability", work: "checkout", runtime: "pi", repo: null, repoName: "ws", agentsRoot: "/ws/agents", workspace: "/ws" },
    ];
    const ctx = {
      api: async (pathname, opts) => ({
        ok: true, status: 200,
        json: async () => {
          if (pathname.startsWith("/api/agents")) return { workspace: { id: "/ws", name: "ws" }, agents };
          if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws", name: "ws" }, workspaces: [{ id: "/ws", name: "ws" }], instances: [] };
          if (pathname === "/api/cli") return state.get;
          if (pathname === "/api/cli/reprobe") return state.post;
          return {};
        },
      }),
      openTerminal: () => {}, openBrain: () => {},
    };
    const el = doc.createElement("div"); doc.body.append(el);
    sp.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // one consistent card, above a STILL-RENDERED roster (reads keep working)
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "exactly one degradation card");
    const cards = [...el.querySelectorAll(".soul-card")];
    assert.equal(cards.length, 2, "soul cards (reads) still render");
    for (const b of el.querySelectorAll(".spawn-act")) {
      assert.equal(b.disabled, true, "every spawn button disabled");
      assert.match(b.title, /oas CLI/, "tooltip explains the CLI requirement");
    }
    // clicking a disabled-state card never opens the form
    cards[0].querySelector(".spawn-act")?.dispatchEvent(new doc.defaultView.Event("click"));
    assert.equal(el.querySelector(".soul-form"), null, "no spawn form opens without a CLI");
    // brain (read) action remains enabled
    assert.ok([...el.querySelectorAll(".brain-act")].every((b) => !b.disabled), "View brain stays usable");
    // CLI becomes available → card disappears, buttons enable (same subscribe path)
    state.get = payload(true);
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 0, "card removed once compatible");
    assert.ok([...el.querySelectorAll(".spawn-act")].every((b) => !b.disabled), "spawn re-enabled");
    sp.unmount();
  } finally {
    delete globalThis.document;
  }
});
