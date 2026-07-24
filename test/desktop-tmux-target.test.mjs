// Regression for merged-state round 3: the desktop attach target must be
// exact-match anchored (=session:=window) — tmux -t prefix-matches by
// default, so an unanchored target with a stale roster attaches keystrokes
// to the WRONG agent's similarly named window. Includes a live-tmux proof
// (skipped when tmux is unavailable) that the anchored form rejects a
// missing exact target instead of prefix-matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmuxAttachTarget, openTerm, sweepViewers, LOCKED_TABLE_BINDINGS } from "../packages/desktop/tmux-target.mjs";

const RENDERER_PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "desktop");

test("anchors both components: =session:=window", () => {
  assert.equal(tmuxAttachTarget("pi-agents", "reviewer-1"), "=pi-agents:=reviewer-1");
  assert.equal(tmuxAttachTarget("s", 3), "=s:=3");
  assert.equal(tmuxAttachTarget("s"), "=s");
  assert.equal(tmuxAttachTarget("s", null), "=s");
});

test("rejects malformed session/window values", () => {
  for (const bad of [undefined, 42, "", "a:b", "a b", "$(x)", "a;b", "=s"]) {
    assert.throws(() => tmuxAttachTarget(bad, "w"), /bad session/, `session ${JSON.stringify(bad)}`);
  }
  for (const bad of ["a:b", "a b", "$(x)", "a;b", "=w", ""]) {
    assert.throws(() => tmuxAttachTarget("s", bad), /bad window/, `window ${JSON.stringify(bad)}`);
  }
});

test("only undefined/null mean 'no window' — empty string fails closed", () => {
  // review tmuxtgt nit: an explicit "" must not silently become a
  // session-only target (selecting the session's CURRENT window).
  assert.equal(tmuxAttachTarget("s", undefined), "=s");
  assert.equal(tmuxAttachTarget("s", null), "=s");
  assert.throws(() => tmuxAttachTarget("s", ""), /bad window/);
});

// openTerm: the sequence that had the bug (review tmuxtgt2) — preflight must
// run and reject BEFORE any pty is spawned; success builds a LINKED-WINDOW
// viewer session (phase-2 hook 2 + reviewer-936f9a3's escape: grouping
// shared window MEMBERSHIP, so sibling auto-select on window death and
// viewer-side window-nav keys could steer the tab to another agent — the
// viewer must contain ONLY a link to the exact window, with keys locked).
const fakeIo = (calls, opts = {}) => ({
  preflight: (t) => { calls.push(["preflight", t]); if (opts.preflightFails) throw new Error("absent"); },
  tmux: (args) => { calls.push(["tmux", ...args]); if (opts.tmuxFails?.(args)) throw new Error("tmux failed"); },
  tmuxOut: (args) => { calls.push(["tmuxOut", ...args]); return opts.windowId ?? "@7"; },
  spawnPty: (t, c, r) => { calls.push(["spawn", t, c, r]); if (opts.spawnFails) throw new Error("pty failed"); return opts.pty ?? {}; },
  uniqueName: () => "oasdesk-test-1",
});

test("openTerm: failed preflight rejects before any viewer/pty exists", () => {
  const calls = [];
  assert.throws(() => openTerm({ session: "s", window: "gone" }, fakeIo(calls, { preflightFails: true })),
    /no tmux target =s:=gone/);
  assert.deepEqual(calls, [["preflight", "=s:=gone"]], "no viewer created, no pty spawned");
});

test("openTerm: linked-window viewer built in order, keys locked, pty attaches to the viewer", () => {
  const calls = [];
  const fake = { fake: true };
  const r = openTerm({ session: "s", window: "w", cols: 120, rows: 40 }, fakeIo(calls, { pty: fake }));
  assert.deepEqual(calls, [
    ["preflight", "=s:=w"],
    ["tmuxOut", "new-session", "-d", "-s", "oasdesk-test-1", "-P", "-F", "#{window_id}"], // placeholder, id captured (index-agnostic)
    ["tmux", "link-window", "-s", "=s:=w", "-t", "=oasdesk-test-1:"],        // exact window linked; tmux picks a free index
    ["tmux", "kill-window", "-t", "@7"],                                      // placeholder dropped BY ID — link is the ONLY window
    ["tmux", "set-option", "-t", "oasdesk-test-1", "prefix", "None"],         // key lock: no prefix → no window-management ops
    ["tmux", "set-option", "-t", "oasdesk-test-1", "prefix2", "None"],
    ["tmux", "set-option", "-t", "oasdesk-test-1", "key-table", "oasdesk-locked"],
    ["tmux", "unbind-key", "-a", "-q", "-T", "oasdesk-locked"],              // tables are server-global: clear stale bindings first
    ...LOCKED_TABLE_BINDINGS.map((b) => ["tmux", "bind-key", "-T", "oasdesk-locked", ...b]), // provisioned wheel bindings
    ["tmux", "set-option", "-t", "oasdesk-test-1", "mouse", "on"],            // wheel events reach tmux
    ["spawn", "=oasdesk-test-1", 120, 40],                                     // pty attaches to the viewer
  ]);
  assert.equal(r.pty, fake);
  assert.equal(r.viewer, "oasdesk-test-1");
  // cleanup contract: killViewer kills ONLY the =-anchored viewer session
  r.killViewer();
  assert.deepEqual(calls.at(-1), ["tmux", "kill-session", "-t", "=oasdesk-test-1"]);
});

test("openTerm: viewer is killed (not leaked) when link, lock, or pty spawn fails — and on a malformed window id", () => {
  for (const opts of [
    { tmuxFails: (a) => a[0] === "link-window" },
    { tmuxFails: (a) => a[0] === "set-option" },
    { spawnFails: true },
    { windowId: "definitely-not-an-id" },
  ]) {
    const calls = [];
    assert.throws(() => openTerm({ session: "s", window: "w" }, fakeIo(calls, opts)));
    assert.deepEqual(calls.at(-1), ["tmux", "kill-session", "-t", "=oasdesk-test-1"], `viewer cleaned up (${JSON.stringify(Object.keys(opts))})`);
  }
});

test("openTerm: dimension clamping and validation flow through", () => {
  const calls = [];
  openTerm({ session: "s", cols: 0, rows: -5 }, fakeIo(calls));
  assert.deepEqual(calls.at(-1), ["spawn", "=oasdesk-test-1", 80, 5], "cols default applied, rows clamped to minimum");
  // no window → whole session linked? No: link-window needs a window — the
  // session-only form links the session's target shorthand — assert we still
  // linked from the anchored session target.
  assert.ok(calls.some((c) => c[1] === "link-window" && c[3] === "=s"), "session-only target linked as-is");
  assert.throws(() => openTerm({ session: "a:b", window: "w" }, fakeIo([])), /bad session/);
});

test("sweepViewers: kills only dead-pid oasdesk sessions", () => {
  const killed = [];
  const swept = sweepViewers({
    listSessions: () => ["pi-agents", "oasdesk-99999999-1-abc", `oasdesk-${process.pid}-1-live`, "oasdesk-1-2-x", "unrelated"],
    killSession: (n) => killed.push(n),
    pidAlive: (pid) => pid === 1, // pid 1 "alive", 99999999 dead
  });
  assert.deepEqual(swept, ["oasdesk-99999999-1-abc"], "only the dead orphan");
  assert.deepEqual(killed, ["oasdesk-99999999-1-abc"]);
});

test("live tmux: anchored target rejects a missing exact window instead of prefix-matching", (t) => {
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("tmux not available");
  const session = `oastgt${process.pid}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-n", "reviewer-15c135c", "sh"], { timeout: 5000 });
    // Unanchored "session:reviewer-1" would PREFIX-MATCH the live
    // "reviewer-15c135c" window — the wrong-agent hazard.
    const unanchored = spawnSync("tmux", ["list-panes", "-t", `${session}:reviewer-1`], { encoding: "utf8", timeout: 5000 });
    // Anchored form must refuse: no exact "reviewer-1" window exists. This
    // is what makes openTerm's preflight (which runs exactly this
    // list-panes check) reject a missing exact target.
    const anchored = spawnSync("tmux", ["list-panes", "-t", tmuxAttachTarget(session, "reviewer-1")], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(anchored.status, 0, "anchored target must NOT resolve a prefix match");
    if (unanchored.status === 0) {
      // this tmux prefix-matches (the hazard is real on this box) — the
      // anchored form above is what protects us; nothing more to assert.
    }
    // And the anchored form still resolves the EXACT window.
    const exact = spawnSync("tmux", ["list-panes", "-t", tmuxAttachTarget(session, "reviewer-15c135c")], { encoding: "utf8", timeout: 5000 });
    assert.equal(exact.status, 0, "anchored exact target resolves");
  } finally {
    spawnSync("tmux", ["kill-session", "-t", `=${session}`], { timeout: 5000 });
  }
});

test("live tmux: linked-window viewer — source window death terminates the viewer, never activates a sibling", (t) => {
  // reviewer-936f9a3 regression (a): live A+B; viewer on A; destroy A →
  // viewer/pty target dies (NEVER activates B); B and the source survive.
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("tmux not available");
  const src = `oaslwsrc${process.pid}`;
  let viewer = null;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", src, "-n", "instA", "sh"], { timeout: 5000 });
    execFileSync("tmux", ["new-window", "-t", `=${src}`, "-n", "instB", "sh"], { timeout: 5000 });

    const r = openTerm({ session: src, window: "instA" }, {
      preflight: (target) => execFileSync("tmux", ["list-panes", "-t", target], { stdio: "ignore", timeout: 5000 }),
      tmux: (args) => execFileSync("tmux", args, { stdio: "ignore", timeout: 5000 }),
      tmuxOut: (args) => execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 }).trim(),
      spawnPty: (target) => ({ target }),
    });
    viewer = r.viewer;
    assert.equal(r.pty.target, `=${viewer}`, "pty attaches to the viewer session");
    const vwins = spawnSync("tmux", ["list-windows", "-t", `=${viewer}`, "-F", "#{window_name}"], { encoding: "utf8", timeout: 5000 }).stdout.trim().split("\n");
    assert.deepEqual(vwins, ["instA"], "viewer contains ONLY the linked window");

    // membership isolation: source window switches don't affect the viewer
    execFileSync("tmux", ["select-window", "-t", `=${src}:=instB`], { timeout: 5000 });
    const vactive = spawnSync("tmux", ["list-windows", "-t", `=${viewer}`, "-F", "#{window_name} #{?window_active,A,}"], { encoding: "utf8", timeout: 5000 }).stdout;
    assert.match(vactive, /instA A/, "viewer still on instA");

    // THE escape: retire (kill) source instA — viewer must DIE, never show instB
    execFileSync("tmux", ["kill-window", "-t", `=${src}:=instA`], { timeout: 5000 });
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      alive = spawnSync("tmux", ["has-session", "-t", `=${viewer}`], { timeout: 5000 }).status === 0;
      if (alive) { const w = spawnSync("tmux", ["list-windows", "-t", `=${viewer}`, "-F", "#{window_name}"], { encoding: "utf8", timeout: 5000 }).stdout; assert.ok(!w.includes("instB"), "viewer must NEVER contain/activate instB"); }
    }
    assert.equal(alive, false, "viewer terminated when its only (linked) window died");
    viewer = null;
    const sessions = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 5000 }).stdout;
    assert.ok(sessions.includes(src), "source session survives");
    const windows = spawnSync("tmux", ["list-windows", "-t", `=${src}`, "-F", "#{window_name}"], { encoding: "utf8", timeout: 5000 }).stdout;
    assert.ok(windows.includes("instB"), "sibling window B survives");
  } finally {
    if (viewer) spawnSync("tmux", ["kill-session", "-t", `=${viewer}`], { timeout: 5000 });
    spawnSync("tmux", ["kill-session", "-t", `=${src}`], { timeout: 5000 });
  }
});

test("live tmux: viewer key path cannot leave the linked window; viewer kill spares the source", (t) => {
  // reviewer-936f9a3 regression (b): window-management keys are inert in the
  // viewer (prefix None + locked key-table), and teardown never touches the
  // source. Driven via send-keys of the default prefix + window-nav keys.
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("tmux not available");
  const src = `oaslwsrc2${process.pid}`;
  let viewer = null;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", src, "-n", "instA", "sh"], { timeout: 5000 });
    execFileSync("tmux", ["new-window", "-t", `=${src}`, "-n", "instB", "sh"], { timeout: 5000 });
    const r = openTerm({ session: src, window: "instA" }, {
      preflight: (target) => execFileSync("tmux", ["list-panes", "-t", target], { stdio: "ignore", timeout: 5000 }),
      tmux: (args) => execFileSync("tmux", args, { stdio: "ignore", timeout: 5000 }),
      tmuxOut: (args) => execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 }).trim(),
      spawnPty: (target) => ({ target }),
    });
    viewer = r.viewer;
    // prefix and key-table are locked
    const opts = spawnSync("tmux", ["show-options", "-t", viewer], { encoding: "utf8", timeout: 5000 }).stdout;
    assert.match(opts, /prefix None/, "prefix disabled");
    assert.match(opts, /key-table oasdesk-locked/, "nonexistent key table");
    // attempt window-management via the (disabled) prefix path: C-b n / C-b l /
    // C-b c / C-b 1 — with prefix None these are raw bytes to the pane, not commands
    for (const keys of [["C-b", "n"], ["C-b", "l"], ["C-b", "c"], ["C-b", "1"]]) {
      spawnSync("tmux", ["send-keys", "-t", `=${viewer}`, ...keys], { timeout: 5000 });
    }
    const wins = spawnSync("tmux", ["list-windows", "-t", `=${viewer}`, "-F", "#{window_name}"], { encoding: "utf8", timeout: 5000 }).stdout.trim().split("\n");
    assert.deepEqual(wins, ["instA"], "no nav/new escaped the linked window (no new/other windows)");
    // teardown: killing the viewer spares the source and both its windows
    r.killViewer();
    viewer = null;
    const windows = spawnSync("tmux", ["list-windows", "-t", `=${src}`, "-F", "#{window_name}"], { encoding: "utf8", timeout: 5000 }).stdout;
    assert.ok(windows.includes("instA") && windows.includes("instB"), "source windows survive viewer kill");
  } finally {
    if (viewer) spawnSync("tmux", ["kill-session", "-t", `=${viewer}`], { timeout: 5000 });
    spawnSync("tmux", ["kill-session", "-t", `=${src}`], { timeout: 5000 });
  }
});

test("live tmux: viewer construction works under a nonzero base-index (isolated server)", (t) => {
  // reviewer-linkview regression: with base-index 1 the placeholder is not
  // at index 0 — window-id-based construction must not care. Isolated tmux
  // server (-S socket) so the user's real server/options are untouched.
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("tmux not available");
  const sock = `/tmp/oasbi-${process.pid}.sock`;
  const T = (args, out = false) => {
    const r = spawnSync("tmux", ["-S", sock, ...args], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr}`);
    return out ? r.stdout.trim() : undefined;
  };
  try {
    T(["new-session", "-d", "-s", "boot", "sh"]);        // boot the server
    T(["set-option", "-g", "base-index", "1"]);           // the customization that broke fixed indices
    T(["new-session", "-d", "-s", "src", "-n", "instA", "sh"]);
    T(["new-window", "-t", "=src", "-n", "instB", "sh"]);
    assert.equal(T(["list-windows", "-t", "=src", "-F", "#{window_index} #{window_name}"], true).split("\n")[0], "1 instA",
      "base-index 1 active: first window at index 1");

    const r = openTerm({ session: "src", window: "instA" }, {
      preflight: (target) => T(["list-panes", "-t", target]),
      tmux: (args) => T(args),
      tmuxOut: (args) => T(args, true),
      spawnPty: (target) => ({ target }),
    });
    const wins = T(["list-windows", "-t", `=${r.viewer}`, "-F", "#{window_name}"], true).split("\n");
    assert.deepEqual(wins, ["instA"], "viewer contains ONLY the linked window despite base-index 1");
    r.killViewer();
    assert.ok(T(["list-windows", "-t", "=src", "-F", "#{window_name}"], true).includes("instA"), "source intact");
  } finally {
    spawnSync("tmux", ["-S", sock, "kill-server"], { timeout: 5000 });
    spawnSync("rm", ["-f", sock], { timeout: 5000 });
  }
});

test("locked table provisions ONLY the approved wheel bindings — no window management", () => {
  // Unit guard on the exported binding set itself (the live test asserts
  // the installed table): exactly the approved keys, and none of the
  // window-management commands can appear in any binding.
  const keys = LOCKED_TABLE_BINDINGS.map(([k]) => k);
  assert.deepEqual(keys, ["WheelUpPane"], "exactly the approved binding keys");
  const flat = LOCKED_TABLE_BINDINGS.flat().join(" ");
  for (const forbidden of ["next-window", "previous-window", "last-window", "new-window", "select-window", "kill-window", "choose-", "switch-client"]) {
    assert.ok(!flat.includes(forbidden), `no ${forbidden} in the locked table`);
  }
  assert.match(flat, /copy-mode -e/, "wheel enters exit-at-bottom copy mode");
  assert.match(flat, /send-keys -M/, "mouse event forwarded");
});

test("live tmux: real wheel events through an attached pty client — installed binding enters copy mode and scrolls; stale table bindings are cleared", async (t) => {
  // reviewer-wheelbind regressions: (1) key tables are server-global — a
  // stale forbidden binding seeded into oasdesk-locked BEFORE openTerm must
  // be gone after construction; (2) the INSTALLED WheelUpPane binding is
  // driven by real SGR mouse bytes from an attached client (node-pty), not
  // by manually running copy-mode: first wheel enters copy mode, second
  // scrolls (position increases), wheel-down returns to bottom and exits.
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("tmux not available");
  let ptyMod;
  try {
    // node-pty lives in packages/desktop's node_modules — resolve from there
    ptyMod = createRequire(join(RENDERER_PKG, "package.json"))("node-pty");
  }
  catch { return t.skip("node-pty not available/built for this node ABI"); }
  const sock = `/tmp/oaswhl-${process.pid}.sock`;
  const T = (args, out = false) => {
    const r = spawnSync("tmux", ["-S", sock, ...args], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${r.stderr}`);
    return out ? r.stdout.trim() : undefined;
  };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  let client = null;
  try {
    T(["new-session", "-d", "-s", "src", "-n", "instA", "sh"]);
    T(["send-keys", "-t", "=src:=instA", "seq 1 200", "Enter"]);
    await sleep(800); // >pane-height history

    // seed a STALE forbidden binding into the (server-global) locked table
    T(["bind-key", "-T", "oasdesk-locked", "n", "next-window"]);

    const r = openTerm({ session: "src", window: "instA" }, {
      preflight: (target) => T(["list-panes", "-t", target]),
      tmux: (args) => T(args),
      tmuxOut: (args) => T(args, true),
      spawnPty: (target, cols, rows) => ptyMod.spawn("tmux", ["-S", sock, "attach-session", "-t", target], {
        name: "xterm-256color", cols, rows, env: process.env,
      }),
    });
    client = r.pty;
    await sleep(1200); // client attached

    // (1) the stale forbidden binding was cleared by the unbind-all
    const table = T(["list-keys", "-T", "oasdesk-locked"], true);
    assert.ok(!table.includes("next-window"), "stale forbidden binding cleared from the server-global table");
    assert.match(table, /WheelUpPane/, "allow-list installed");

    // (2) REAL wheel events (SGR mouse) through the attached client drive
    // the installed binding — mutations breaking the if-shell condition or
    // command syntax fail here.
    client.write("\x1b[<64;10;10M");           // wheel up: binding fires → copy-mode -e
    await sleep(600);
    assert.equal(T(["display-message", "-p", "-t", r.viewer, "#{pane_in_mode}"], true), "1", "first wheel entered copy mode");
    client.write("\x1b[<64;10;10M");           // second wheel: copy-mode WheelUpPane scrolls
    await sleep(600);
    const pos = Number(T(["display-message", "-p", "-t", r.viewer, "#{scroll_position}"], true));
    assert.ok(pos > 0, `scroll position increased (${pos})`);
    // wheel-down back to bottom: -e exits copy mode
    for (let i = 0; i < 4; i++) { client.write("\x1b[<65;10;10M"); await sleep(200); }
    assert.equal(T(["display-message", "-p", "-t", r.viewer, "#{pane_in_mode}"], true), "0", "copy mode exited at bottom");

    // window pinned throughout; teardown spares the source
    assert.deepEqual(T(["list-windows", "-t", `=${r.viewer}`, "-F", "#{window_name}"], true).split("\n"), ["instA"]);
    client.kill();
    client = null;
    r.killViewer();
    assert.ok(T(["list-windows", "-t", "=src", "-F", "#{window_name}"], true).includes("instA"), "source intact");
  } finally {
    if (client) { try { client.kill(); } catch { /* gone */ } }
    spawnSync("tmux", ["-S", sock, "kill-server"], { timeout: 5000 });
    spawnSync("rm", ["-f", sock], { timeout: 5000 });
  }
});
