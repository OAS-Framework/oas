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

// ── Shift+Enter → newline (chat-input fix) ────────────────────────────────
// xterm emits a plain \r for Enter with or without Shift, so the modifier
// never reaches tmux/pi. The composition installs a custom key handler that
// translates Shift+Enter into a raw \n (pi's Ctrl+J newline alias) and
// suppresses the default \r. xterm invokes the handler for keydown,
// keypress AND keyup of the same press — suppressing only keydown leaks a
// \r through the keypress path, which SENT the message right after the
// newline (the v0.18.4 field failure). These drive the pure classifier AND
// the wired handler behavior — a regression that keeps the classifier but
// forgets to suppress the default (returning true) would send anyway.
import { shiftEnterAction } from "../renderer/terminal-tab.mjs";

test("shiftEnterAction: Shift+Enter suppresses every event; \\n only on keydown", () => {
  const ev = (o) => ({ type: "keydown", key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true })), { suppress: true, byte: "\n" });
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, type: "keypress" })), { suppress: true, byte: null }, "keypress suppressed, no second write");
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, type: "keyup" })), { suppress: true, byte: null }, "keyup suppressed, no write");
  assert.deepEqual(shiftEnterAction(ev({})), { suppress: false, byte: null }, "plain Enter untouched (still sends)");
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, ctrlKey: true })), { suppress: false, byte: null }, "extra modifiers pass through");
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, metaKey: true })), { suppress: false, byte: null });
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, altKey: true })), { suppress: false, byte: null });
  assert.deepEqual(shiftEnterAction(ev({ key: "a", shiftKey: true })), { suppress: false, byte: null }, "shifted letters untouched");
});

test("custom key handler: Shift+Enter writes \\n once and suppresses keydown, keypress and keyup", async () => {
  const d = makeDoubles(Promise.resolve(5));
  let handler = null;
  const writes = [];
  d.term.attachCustomKeyEventHandler = (h) => { handler = h; };
  d.desk.termWrite = (id, data) => writes.push([id, data]);
  const tab = mk(d);
  await tab.start();
  assert.equal(typeof handler, "function", "handler installed during onReady");
  const ev = (o) => ({ type: "keydown", key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.equal(handler(ev({ shiftKey: true })), false, "keydown suppressed (default \\r blocked)");
  assert.deepEqual(writes, [[5, "\n"]], "newline byte written to the live pty");
  assert.equal(handler(ev({ shiftKey: true, type: "keypress" })), false, "keypress suppressed — the \\r leak that SENT the message");
  assert.equal(handler(ev({ shiftKey: true, type: "keyup" })), false, "keyup suppressed");
  assert.deepEqual(writes, [[5, "\n"]], "exactly one write for the whole chord");
  assert.equal(handler(ev({})), true, "plain Enter left to xterm (message sends)");
  assert.equal(writes.length, 1, "no extra writes for pass-through keys");
  await tab.close();
  writes.length = 0;
  assert.equal(handler(ev({ shiftKey: true })), false);
  assert.deepEqual(writes, [], "no write after the pty is gone");
});

// ── Option+drag local selection (copy fix) ────────────────────────────────
// The viewer tmux session runs `mouse on`, so tmux consumes plain drags and
// xterm never builds a local selection — copy from a terminal looked broken.
// terminalOptions() must force macOptionClickForcesSelection on, and
// shell.mjs must actually construct its Terminal through terminalOptions
// (an inline options object would silently drop the invariant).
import { terminalOptions } from "../renderer/terminal-tab.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

test("terminalOptions: forces Option+drag local selection and carries typography/theme", () => {
  const o = terminalOptions({ fontSize: 13, fontFamily: "mono", theme: { background: "#000" } });
  assert.equal(o.macOptionClickForcesSelection, true, "Option+drag must force a LOCAL xterm selection (tmux mouse-on eats plain drags)");
  assert.equal(o.scrollback, 5000);
  assert.equal(o.fontSize, 13);
  assert.equal(o.fontFamily, "mono");
  assert.deepEqual(o.theme, { background: "#000" });
});

test("shell.mjs constructs its Terminal through terminalOptions", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "renderer", "shell.mjs"), "utf8");
  assert.match(src, /new Terminal\(terminalOptions\(/, "shell must build xterm options via terminalOptions()");
});

// ── shortcut interception before the pty (review d64daeb important) ──────
// xterm's capture-phase textarea handler consumes allowlisted chords (e.g.
// Ctrl+K) — preventDefault + stopPropagation — so the shell's bubble-phase
// window listener NEVER sees them and a control byte goes to the attached
// program instead. The composition's interceptKey hook runs inside xterm's
// custom key handler (before any pty write): a claimed chord is suppressed
// for every phase and its byte never reaches the pty.
import { terminalKeyDecision } from "../renderer/terminal-tab.mjs";

test("terminalKeyDecision: Shift+Enter wins, then interception, else pass-through", () => {
  const ev = (o) => ({ type: "keydown", key: "k", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  // Shift+Enter translation takes precedence and carries its byte
  assert.deepEqual(terminalKeyDecision(ev({ key: "Enter", shiftKey: true }), () => true), { handled: true, byte: "\n" });
  // intercepted chord: handled, no byte
  assert.deepEqual(terminalKeyDecision(ev({ ctrlKey: true }), () => true), { handled: true, byte: null });
  // not intercepted: xterm processes normally
  assert.deepEqual(terminalKeyDecision(ev({ ctrlKey: true }), () => false), { handled: false, byte: null });
  assert.deepEqual(terminalKeyDecision(ev({}), undefined), { handled: false, byte: null }, "no hook, no claim");
});

test("wired handler: an intercepted chord is suppressed in every phase and writes nothing to the pty", async () => {
  const d = makeDoubles(Promise.resolve(9));
  let handler = null;
  const writes = [];
  const intercepted = [];
  d.term.attachCustomKeyEventHandler = (h) => { handler = h; };
  d.desk.termWrite = (id, data) => writes.push([id, data]);
  // stand-in for the engine's terminal-allowlist match: claims Ctrl+K
  const interceptKey = (ev) => {
    const hit = ev.key === "k" && ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey;
    if (hit && ev.type === "keydown") intercepted.push(ev.type);
    return hit;
  };
  const tab = mk(d, { interceptKey });
  await tab.start();
  const ev = (o) => ({ type: "keydown", key: "k", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.equal(handler(ev({ ctrlKey: true })), false, "keydown claimed — xterm must not write the control byte");
  assert.equal(handler(ev({ ctrlKey: true, type: "keypress" })), false, "keypress claimed too (no byte leak)");
  assert.equal(handler(ev({ ctrlKey: true, type: "keyup" })), false, "keyup claimed");
  assert.deepEqual(writes, [], "nothing written to the pty for an intercepted chord");
  assert.deepEqual(intercepted, ["keydown"], "action dispatch observed once, on keydown");
  assert.equal(handler(ev({})), true, "plain k left to xterm (types into the terminal)");
  assert.equal(handler(ev({ key: "Enter", shiftKey: true })), false, "Shift+Enter still composes");
  assert.deepEqual(writes, [[9, "\n"]], "Shift+Enter newline still written");
  await tab.close();
});

test("shell wires interceptKey through the engine's terminal policy", () => {
  const here2 = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here2, "..", "renderer", "shell.mjs"), "utf8");
  assert.match(src, /interceptKey: \(ev\) => \{/, "shell provides the interception hook");
  assert.match(src, /matchEvent\(ev, \{ insideTerminal: true \}\)/, "hook consults the engine allowlist");
  assert.match(src, /if \(ev\.type === "keydown"\) handleKeydown\(ev, \{ insideTerminal: true \}\)/, "action runs once, on keydown");
});
