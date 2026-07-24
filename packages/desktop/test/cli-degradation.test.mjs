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

test("spawn view: UNKNOWN state disables spawn WITHOUT the card; unavailable adds the card (frozen contract)", async () => {
  const doc = dom();
  globalThis.document = doc;
  try {
    const sp = await import("../renderer/views/spawn.mjs");
    const agents = [{ name: "dev", description: "d", kind: "persistent", work: "worktree", runtime: "pi", repo: "/r", repoName: "r", agentsRoot: "/ws/agents", workspace: "/ws" }];
    // /api/cli answers a LEGACY shape first → state resolves to UNKNOWN
    const state = { cliPayload: { legacy: true }, posts: [] };
    const ctx = {
      api: async (pathname, opts) => ({
        ok: true, status: 200,
        json: async () => {
          if (pathname.startsWith("/api/agents")) return { workspace: { id: "/ws", name: "ws" }, agents };
          if (pathname.startsWith("/api/panel")) return { workspace: { id: "/ws", name: "ws" }, workspaces: [{ id: "/ws", name: "ws" }], instances: [] };
          if (pathname === "/api/cli") return state.cliPayload;
          if (pathname === "/api/spawn") { state.posts.push(opts); return { spawned: true, instance: "dev-x" }; }
          return {};
        },
      }),
      openTerminal: () => {}, openBrain: () => {},
    };
    const el = doc.createElement("div"); doc.body.append(el);
    sp.mount(el, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // FROZEN CONTRACT: unknown does NOT render capable — spawn disabled,
    // but no card yet (the launch probe resolves in ms; the card is for
    // KNOWN incompatibility).
    const spawnBtn = el.querySelector(".spawn-act");
    assert.ok(spawnBtn, "spawn button renders");
    assert.equal(spawnBtn.disabled, true, "unknown state disables spawn (mutations need a VERIFIED CLI)");
    assert.equal(el.querySelectorAll(".cli-card").length, 0, "no degradation card while merely unknown");
    spawnBtn.dispatchEvent(new doc.defaultView.Event("click"));
    assert.equal(el.querySelector(".soul-form"), null, "no form opens while unknown");
    // the probe lands UNAVAILABLE → the card appears, buttons stay disabled
    state.cliPayload = payload(false);
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(el.querySelectorAll(".cli-card").length, 1, "known-unavailable shows the card");
    assert.ok([...el.querySelectorAll(".spawn-act")].every((b) => b.disabled), "spawn stays disabled");
    // doSpawn re-check: even a stale direct call cannot dispatch
    assert.equal(state.posts.length, 0, "no spawn was ever dispatched");
    // recovery: a compatible probe re-enables and opens forms again
    state.cliPayload = payload(true);
    await cs.refreshCli(ctx);
    await new Promise((r) => setTimeout(r, 20));
    const btn2 = el.querySelector(".spawn-act");
    assert.ok(btn2 && !btn2.disabled, "verified CLI re-enables spawn");
    btn2.dispatchEvent(new doc.defaultView.Event("click"));
    assert.ok(el.querySelector(".soul-form"), "form opens once the CLI is verified");
    sp.unmount();
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
