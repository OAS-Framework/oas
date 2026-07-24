// Shell-composition regressions for the terminal tab (review termlc2): the
// lifecycle-only tests pass even if the composition performs setup after
// `await start()` — these drive createTerminalTab, the exact code shell.mjs
// runs, with doubles for the preload bridge and xterm.
//   * close-during-pending: NO setup happens (no handlers, no observer, no
//     focus) and the late pty is detached;
//   * live path: every resource set up in onReady is disposed by close, and
//     setup strictly precedes teardown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createTerminalTab } from "../renderer/terminal-tab.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

function makeDoubles(openPromise) {
  const log = [];
  const doc = new JSDOM("<!doctype html><body></body>").window.document;
  const wrap = doc.createElement("div");
  doc.body.append(wrap);
  const desk = {
    termOpen: () => { log.push("open"); return openPromise; },
    termClose: (id) => log.push(`closePty:${id}`),
    termWrite: () => log.push("write"),
    termResize: () => log.push("resize"),
    onTermData: () => { log.push("onData+"); return () => log.push("onData-"); },
    onTermExit: () => { log.push("onExit+"); return () => log.push("onExit-"); },
  };
  const term = {
    cols: 80, rows: 24,
    onData: () => log.push("term.onData"),
    onResize: () => log.push("term.onResize"),
    focus: () => log.push("focus"),
    dispose: () => log.push("term.dispose"),
    write: () => {},
  };
  return { log, wrap, desk, term };
}

const mk = (d, extra = {}) => createTerminalTab({
  desk: d.desk, term: d.term, tmux: { session: "s", window: 1 }, wrap: d.wrap,
  isActive: () => true, fit: () => {},
  observe: () => { d.log.push("observe+"); return () => d.log.push("observe-"); },
  onError: () => {},
  ...extra,
});

test("close during pending open: no setup at all, late pty detached, UI disposed once", async () => {
  const gate = deferred();
  const d = makeDoubles(gate.promise);
  const tab = mk(d);
  const starting = tab.start();
  const closing = tab.close();          // close while termOpen is pending
  gate.resolve(42);                     // pty materializes late
  await starting;
  await closing;
  assert.deepEqual(d.log, ["open", "closePty:42", "term.dispose"],
    "no handlers/observer/focus on a closed tab; late pty detached; single teardown");
  assert.equal(d.wrap.querySelector(".term-banner"), null, "no banner on a closed tab");
});

test("live path: setup in onReady, close disposes every resource, setup precedes teardown", async () => {
  const d = makeDoubles(Promise.resolve(7));
  const tab = mk(d);
  await tab.start();
  const setupEnd = d.log.length;
  assert.deepEqual(d.log.slice(0, setupEnd),
    ["open", "onData+", "onExit+", "term.onData", "term.onResize", "observe+", "focus"],
    "all setup inside onReady, in order");
  await tab.close();
  assert.deepEqual(d.log.slice(setupEnd),
    ["onData-", "onExit-", "observe-", "term.dispose", "closePty:7"].sort((a, b) =>
      d.log.slice(setupEnd).indexOf(a) - d.log.slice(setupEnd).indexOf(b)),
    "teardown disposes exactly the resources setup created");
  // every '+' has its '-' and teardown comes strictly after setup
  for (const r of ["onData", "onExit", "observe"]) {
    assert.ok(d.log.indexOf(`${r}+`) < d.log.indexOf(`${r}-`), `${r}: setup before teardown`);
  }
});

test("open rejection on a live tab shows the banner and close stays safe", async () => {
  const gate = deferred();
  const d = makeDoubles(gate.promise);
  const tab = mk(d);
  const starting = tab.start();
  gate.reject(new Error("attach failed"));
  await starting;
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /attach failed/.test(banner.textContent), "error banner rendered");
  await tab.close();                    // no pty to detach; UI still disposed
  assert.ok(d.log.includes("term.dispose"));
  assert.ok(!d.log.some((l) => l.startsWith("closePty")), "no pty was created");
});

test("session-ended (pty exit) then close: banner shown, no double-kill", async () => {
  const d = makeDoubles(Promise.resolve(9));
  let exitCb;
  d.desk.onTermExit = (_id, cb) => { exitCb = cb; d.log.push("onExit+"); return () => d.log.push("onExit-"); };
  const tab = mk(d);
  await tab.start();
  exitCb();                             // main reports the pty exited
  assert.ok(/session ended/.test(d.wrap.querySelector(".term-banner")?.textContent || ""));
  await tab.close();
  assert.ok(!d.log.some((l) => l.startsWith("closePty")), "forget() prevented a double-kill");
});

// Slice G: the structured term:open result → lifecycle translation
// (review cb7622e-r2 important 1). The doubles above return a bare numeric
// id (the legacy/fallback path); these drive the {id}/{reused}/{capped}/
// {error} shapes main.mjs now returns and assert the actionable banner /
// numeric resolve — a regression (e.g. treating {capped:true} as a truthy
// id) would otherwise pass the whole suite.
test("term:open result translation: {id} resolves to the numeric id (attach proceeds)", async () => {
  const d = makeDoubles(Promise.resolve({ id: 7 }));
  const tab = mk(d);
  await tab.start();
  assert.ok(d.log.includes("focus"), "onReady ran → attach proceeded with the unwrapped id");
  assert.ok(!d.wrap.querySelector(".term-banner"), "no error banner on success");
  await tab.close();
  assert.ok(d.log.includes("closePty:7"), "the unwrapped id is what gets closed");
});

test("term:open result translation: {reused,id} → actionable 'already open' banner, no attach", async () => {
  const d = makeDoubles(Promise.resolve({ reused: true, id: 3 }));
  const tab = mk(d);
  await tab.start();
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /already open/i.test(banner.textContent), `reused banner (got: ${banner?.textContent})`);
  assert.ok(!d.log.includes("focus"), "no attach for a reused target");
  await tab.close();
});

test("term:open result translation: {capped} → 'Terminal limit reached' with the runtime max", async () => {
  const d = makeDoubles(Promise.resolve({ capped: true, active: 20, max: 20 }));
  const tab = mk(d);
  await tab.start();
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /Terminal limit reached \(20\)/.test(banner.textContent), `cap banner (got: ${banner?.textContent})`);
  assert.ok(/Close a terminal tab first/.test(banner.textContent), "actionable guidance present");
  assert.ok(!d.log.includes("focus"), "no attach when capped");
  await tab.close();
});

test("term:open result translation: {error} → surfaces the message, no attach", async () => {
  const d = makeDoubles(Promise.resolve({ error: "no tmux target =s:=1" }));
  const tab = mk(d);
  await tab.start();
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /no tmux target/.test(banner.textContent), `error banner (got: ${banner?.textContent})`);
  assert.ok(!d.log.includes("focus"), "no attach on error");
  await tab.close();
});
