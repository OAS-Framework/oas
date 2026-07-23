// Regression for merged-state round 3: the desktop attach target must be
// exact-match anchored (=session:=window) — tmux -t prefix-matches by
// default, so an unanchored target with a stale roster attaches keystrokes
// to the WRONG agent's similarly named window. Includes a live-tmux proof
// (skipped when tmux is unavailable) that the anchored form rejects a
// missing exact target instead of prefix-matching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { tmuxAttachTarget, openTerm } from "../packages/desktop/tmux-target.mjs";

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
// run and reject BEFORE any pty is spawned; success spawns with the same
// anchored target the preflight verified.
test("openTerm: failed preflight rejects before pty spawn", () => {
  const calls = [];
  assert.throws(() => openTerm({ session: "s", window: "gone" }, {
    preflight: (t) => { calls.push(["preflight", t]); throw new Error("no such window"); },
    spawnPty: (t) => { calls.push(["spawn", t]); return {}; },
  }), /no tmux target =s:=gone/);
  assert.deepEqual(calls, [["preflight", "=s:=gone"]], "pty never spawned after failed preflight");
});

test("openTerm: successful preflight spawns with the SAME anchored target, in order", () => {
  const calls = [];
  const fake = { fake: true };
  const r = openTerm({ session: "s", window: "w", cols: 120, rows: 40 }, {
    preflight: (t) => calls.push(["preflight", t]),
    spawnPty: (t, c, rws) => { calls.push(["spawn", t, c, rws]); return fake; },
  });
  assert.deepEqual(calls, [["preflight", "=s:=w"], ["spawn", "=s:=w", 120, 40]]);
  assert.equal(r.pty, fake);
  assert.equal(r.target, "=s:=w");
});

test("openTerm: dimension clamping and validation flow through", () => {
  const calls = [];
  openTerm({ session: "s", cols: 0, rows: -5 }, {
    preflight: () => {},
    spawnPty: (t, c, r) => { calls.push([t, c, r]); return {}; },
  });
  assert.deepEqual(calls, [["=s", 80, 5]], "cols default applied, rows clamped to minimum; session-only target");
  assert.throws(() => openTerm({ session: "a:b", window: "w" }, { preflight: () => {}, spawnPty: () => ({}) }), /bad session/);
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
