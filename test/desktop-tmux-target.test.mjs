// Regression for merged-state round 3: the desktop attach target must be
// exact-match anchored (=session:=window) — tmux -t prefix-matches by
// default, so an unanchored target with a stale roster attaches keystrokes
// to the WRONG agent's similarly named window. Includes a live-tmux proof
// (skipped when tmux is unavailable) that the anchored form rejects a
// missing exact target instead of prefix-matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { tmuxAttachTarget, openTerm, sweepViewers } from "../packages/desktop/tmux-target.mjs";

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
// run and reject BEFORE any pty is spawned; success creates a GROUPED viewer
// session, selects the exact window IN THE VIEWER, and attaches the pty to
// the viewer (phase-2 hook 2: attaching to the durable session followed its
// shared current-window selection — any client's window switch steered
// every open tab to the wrong agent).
const fakeIo = (calls, opts = {}) => ({
  preflight: (t) => { calls.push(["preflight", t]); if (opts.preflightFails) throw new Error("absent"); },
  tmux: (args) => { calls.push(["tmux", ...args]); if (opts.tmuxFails?.(args)) throw new Error("tmux failed"); },
  spawnPty: (t, c, r) => { calls.push(["spawn", t, c, r]); if (opts.spawnFails) throw new Error("pty failed"); return opts.pty ?? {}; },
  uniqueName: () => "oasdesk-test-1",
});

test("openTerm: failed preflight rejects before any viewer/pty exists", () => {
  const calls = [];
  assert.throws(() => openTerm({ session: "s", window: "gone" }, fakeIo(calls, { preflightFails: true })),
    /no tmux target =s:=gone/);
  assert.deepEqual(calls, [["preflight", "=s:=gone"]], "no viewer created, no pty spawned");
});

test("openTerm: grouped viewer created, exact window selected IN THE VIEWER, pty attaches to the viewer", () => {
  const calls = [];
  const fake = { fake: true };
  const r = openTerm({ session: "s", window: "w", cols: 120, rows: 40 }, fakeIo(calls, { pty: fake }));
  assert.deepEqual(calls, [
    ["preflight", "=s:=w"],
    ["tmux", "new-session", "-d", "-s", "oasdesk-test-1", "-t", "=s"],       // grouped to the durable session
    ["tmux", "select-window", "-t", "=oasdesk-test-1:=w"],                   // selection in the VIEWER only
    ["spawn", "=oasdesk-test-1", 120, 40],                                    // pty attaches to the viewer
  ]);
  assert.equal(r.pty, fake);
  assert.equal(r.viewer, "oasdesk-test-1");
  // cleanup contract: killViewer kills ONLY the =-anchored viewer session
  r.killViewer();
  assert.deepEqual(calls.at(-1), ["tmux", "kill-session", "-t", "=oasdesk-test-1"]);
});

test("openTerm: viewer is killed (not leaked) when window selection or pty spawn fails", () => {
  for (const opts of [{ tmuxFails: (a) => a[0] === "select-window" }, { spawnFails: true }]) {
    const calls = [];
    assert.throws(() => openTerm({ session: "s", window: "w" }, fakeIo(calls, opts)));
    assert.deepEqual(calls.at(-1), ["tmux", "kill-session", "-t", "=oasdesk-test-1"], `viewer cleaned up (${Object.keys(opts)})`);
  }
});

test("openTerm: dimension clamping and validation flow through", () => {
  const calls = [];
  openTerm({ session: "s", cols: 0, rows: -5 }, fakeIo(calls));
  assert.deepEqual(calls.at(-1), ["spawn", "=oasdesk-test-1", 80, 5], "cols default applied, rows clamped to minimum");
  assert.equal(calls.filter((c) => c[1] === "select-window").length, 0, "no window → no select");
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

test("live tmux: grouped viewer is immune to source-session window switches; teardown spares the source", (t) => {
  // The phase-2 hook-2 scenario end-to-end on a real tmux: viewer pinned to
  // window A stays on A while the SOURCE session's selection moves to B;
  // killing the viewer leaves the source session and all windows intact.
  const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return t.skip("tmux not available");
  const src = `oasgsrc${process.pid}`;
  const active = (target) =>
    spawnSync("tmux", ["list-windows", "-t", `=${target}`, "-F", "#{window_name} #{?window_active,A,}"], { encoding: "utf8", timeout: 5000 })
      .stdout.split("\n").find((l) => l.endsWith(" A"))?.split(" ")[0];
  let viewer = null;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", src, "-n", "instA", "sh"], { timeout: 5000 });
    execFileSync("tmux", ["new-window", "-t", `=${src}`, "-n", "instB", "sh"], { timeout: 5000 });
    execFileSync("tmux", ["select-window", "-t", `=${src}:=instB`], { timeout: 5000 });

    // open a viewer on window instA through the REAL openTerm sequence
    // (spawnPty stubbed — attaching a client needs a TTY; the viewer
    // session semantics are what this test pins)
    const r = openTerm({ session: src, window: "instA" }, {
      preflight: (target) => execFileSync("tmux", ["list-panes", "-t", target], { stdio: "ignore", timeout: 5000 }),
      tmux: (args) => execFileSync("tmux", args, { stdio: "ignore", timeout: 5000 }),
      spawnPty: (target) => ({ target }),
    });
    viewer = r.viewer;
    assert.equal(r.pty.target, `=${viewer}`, "pty attaches to the viewer session");
    assert.equal(active(viewer), "instA", "viewer pinned to instance A");

    // another client switches the SOURCE session's current window
    execFileSync("tmux", ["select-window", "-t", `=${src}:=instB`], { timeout: 5000 });
    execFileSync("tmux", ["select-window", "-t", `=${src}:=instA`], { timeout: 5000 });
    execFileSync("tmux", ["select-window", "-t", `=${src}:=instB`], { timeout: 5000 });
    assert.equal(active(viewer), "instA", "viewer selection unaffected by source switches");

    // teardown: kill ONLY the viewer
    r.killViewer();
    viewer = null;
    const sessions = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 5000 }).stdout;
    assert.ok(sessions.includes(src), "source session survives");
    const windows = spawnSync("tmux", ["list-windows", "-t", `=${src}`, "-F", "#{window_name}"], { encoding: "utf8", timeout: 5000 }).stdout;
    assert.ok(windows.includes("instA") && windows.includes("instB"), "all source windows survive");
  } finally {
    if (viewer) spawnSync("tmux", ["kill-session", "-t", `=${viewer}`], { timeout: 5000 });
    spawnSync("tmux", ["kill-session", "-t", `=${src}`], { timeout: 5000 });
  }
});
