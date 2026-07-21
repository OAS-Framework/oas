import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConstellation, classifySessionTail, parseGitDiffStat, parseGitStatus, parseTmuxWindows,
  readMarkdownSection, relativeAge, sessionFileFor, sessionTailState,
} from "../lib/control-pane/model.mjs";
import { renderFrame } from "../lib/control-pane/tui.mjs";

test("readMarkdownSection extracts a top-level section and ignores placeholders", () => {
  const text = "# Task\n\nShip a useful pane.\n\n# Progress\n\n_(nothing yet)_\n\n# Next\n\nBuild it.\n";
  assert.equal(readMarkdownSection(text, "Task"), "Ship a useful pane.");
  assert.equal(readMarkdownSection(text, "Progress"), "");
  assert.equal(readMarkdownSection(text, "Next"), "Build it.");
  assert.equal(readMarkdownSection("# Briefing\n\n## Task\n\nNested task.\n", "Task"), "Nested task.");
});

test("parseTmuxWindows retains an exact switch target", () => {
  assert.deepEqual(parseTmuxWindows("pi-agents\tworker\t@4\t1\tnode\t0"), [{
    session: "pi-agents", window: "worker", id: "@4", active: true, command: "node", dead: false,
  }]);
});

test("parseGitStatus reports branch, divergence, and dirty file count", () => {
  assert.deepEqual(parseGitStatus("## feat/pane...origin/feat/pane [ahead 2, behind 1]\n M a.mjs\n?? b.mjs"), {
    branch: "feat/pane", dirty: 2, ahead: 2, behind: 1,
  });
});

test("parseGitDiffStat sums textual additions and deletions", () => {
  assert.deepEqual(parseGitDiffStat("12\t3\ta.mjs\n4\t0\tb.mjs\n-\t-\timage.png"), { additions: 16, deletions: 3 });
});

test("buildConstellation nests known parents and keeps legacy/orphan instances as roots", () => {
  const parent = { instance: "lead", running: true, createdAt: "2026-01-01" };
  const child = { instance: "worker", parentInstance: "lead", running: true, createdAt: "2026-01-02" };
  const orphan = { instance: "legacy", parentInstance: "retired-parent", running: false, createdAt: "2025-01-01" };
  const rows = buildConstellation([child, orphan, parent]);
  assert.deepEqual(rows.map((row) => [row.instance.instance, row.depth]), [["lead", 0], ["worker", 1], ["legacy", 0]]);
});

test("buildConstellation cannot lose cyclic malformed metadata", () => {
  const rows = buildConstellation([
    { instance: "a", parentInstance: "b", running: true },
    { instance: "b", parentInstance: "a", running: true },
  ]);
  assert.deepEqual(new Set(rows.map((row) => row.instance.instance)), new Set(["a", "b"]));
});

test("relativeAge chooses compact stable units", () => {
  const now = new Date("2026-07-11T12:00:00Z").getTime();
  assert.equal(relativeAge("2026-07-11T11:58:00Z", now), "2m");
  assert.equal(relativeAge("2026-07-09T11:00:00Z", now), "2d");
});

test("classifySessionTail: pi error tail is surfaced with its message", () => {
  const lines = [
    '{"type":"message","timestamp":"2026-07-21T10:00:00Z","message":{"role":"user","content":"do it"}}',
    '{"type":"message","timestamp":"2026-07-21T10:01:00Z","message":{"role":"assistant","stopReason":"error","errorMessage":"No API key for provider anthropic"}}',
  ];
  assert.deepEqual(classifySessionTail(lines, "pi"), {
    state: "error", errorMessage: "No API key for provider anthropic", ts: "2026-07-21T10:01:00Z",
  });
});

test("classifySessionTail: a later normal message means the session recovered", () => {
  const lines = [
    '{"type":"message","timestamp":"t1","message":{"role":"assistant","stopReason":"error","errorMessage":"Token is expired"}}',
    '{"type":"message","timestamp":"t2","message":{"role":"assistant","stopReason":"stop","content":[]}}',
  ];
  assert.deepEqual(classifySessionTail(lines, "pi"), { state: "ok", errorMessage: null, ts: "t2" });
});

test("classifySessionTail: non-message entries and garbage are ignored", () => {
  assert.equal(classifySessionTail(['{"type":"meta"}', "not json"], "pi").state, "unknown");
  assert.equal(classifySessionTail([], "pi").state, "unknown");
});

test("classifySessionTail: claude error markers and recovery", () => {
  const error = '{"type":"assistant","timestamp":"t1","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"OAuth token expired"}]}}';
  assert.deepEqual(classifySessionTail([error], "claude"), { state: "error", errorMessage: "OAuth token expired", ts: "t1" });
  const ok = '{"type":"user","timestamp":"t2","message":{"content":"hi"}}';
  assert.equal(classifySessionTail([error, ok], "claude").state, "ok");
});

test("classifySessionTail truncates long error messages", () => {
  const line = JSON.stringify({ type: "message", timestamp: "t", message: { role: "assistant", stopReason: "error", errorMessage: "x".repeat(2000) } });
  assert.equal(classifySessionTail([line], "pi").errorMessage.length, 500);
});

test("sessionFileFor and sessionTailState tolerate missing session dirs", () => {
  const instance = { home: "/nonexistent/home/for/tests", runtime: "pi" };
  assert.deepEqual(sessionFileFor(instance), { file: undefined, kind: "pi" });
  assert.deepEqual(sessionTailState(instance), { state: "unknown", errorMessage: null, ts: null });
  assert.equal(sessionFileFor({ home: "/nonexistent", runtime: "claude" }).kind, "claude");
});

test("renderFrame is responsive and maps visible constellation rows", () => {
  const instance = {
    instance: "worker", agent: "builder", running: true, createdAt: new Date().toISOString(),
    next: "Run the verification suite", task: "Build the pane", git: { branch: "feat/pane", dirty: 1, ahead: 0, behind: 0 },
    runtime: "pi", work: "worktree", command: "node", knowledgeCount: 7, home: "/tmp/worker",
    tmux: { session: "pi-agents", window: "worker" },
  };
  const snapshot = { root: "/tmp/demo/agents", generatedAt: new Date().toISOString(), instances: [instance], rows: [{ instance, depth: 0, ancestorsLast: [], last: true }], running: 1, soulCount: 1, tmuxAvailable: true };
  for (const [width, height] of [[70, 24], [130, 32]]) {
    const frame = renderFrame(snapshot, { selected: 0, preview: "\x1b[31mhello\x1b[0m\x1b[2J" }, width, height);
    assert.equal(frame.text.split("\n").length, height);
    assert.match(frame.text, /OAS/);
    assert.match(frame.text, /worker/);
    if (width >= 96) {
      assert.match(frame.text, /running/);
      assert.match(frame.text, /unlinked/);
      assert.match(frame.text, /feat\/pane/);
      assert.match(frame.text, /\x1b\[31mhello/);
      assert.doesNotMatch(frame.text, /\x1b\[2J/);
    }
    assert.ok([...frame.rowMap.values()].includes(0));
  }
});

test("renderFrame marks errored sessions and surfaces the error text", () => {
  const instance = {
    instance: "worker", agent: "builder", running: true, createdAt: new Date().toISOString(),
    next: "Recover the session", task: "Build the pane", git: { branch: "main", dirty: 0, ahead: 0, behind: 0 },
    runtime: "pi", work: "worktree", knowledgeCount: 1, home: "/tmp/worker",
    tmux: { session: "pi-agents", window: "worker" },
    sessionTail: { state: "error", errorMessage: "No API key for provider anthropic", ts: null },
  };
  const snapshot = { root: "/tmp/demo/agents", generatedAt: new Date().toISOString(), instances: [instance], rows: [{ instance, depth: 0, ancestorsLast: [], last: true }], running: 1, soulCount: 1, tmuxAvailable: true };
  const frame = renderFrame(snapshot, { selected: 0, preview: "tail" }, 120, 30);
  assert.match(frame.text, /✗ err/);
  assert.match(frame.text, /session error: No API key for provider anthropic/);
  const details = renderFrame(snapshot, { selected: 0, preview: "", previewMode: false }, 120, 30);
  assert.match(details.text, /error {4}/);
  assert.match(details.text, /No API key for provider anthropic/);
  const zoom = renderFrame(snapshot, { selected: 0, preview: "tail", zoom: true }, 120, 30);
  assert.match(zoom.text, /✗ session error: No API key/);
});

test("terminal theme inference: OSC 11 luminance and COLORFGBG fallback shapes", async () => {
  const { parseOsc11 } = await import("../lib/control-pane/tui.mjs");
  assert.equal(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x07"), true);          // white bg
  assert.equal(parseOsc11("\x1b]11;rgb:f6f6/f8f8/fafa\x1b\\"), true);        // light bg, ST terminator
  assert.equal(parseOsc11("\x1b]11;rgb:0e0e/1111/1616\x07"), false);         // dark bg
  assert.equal(parseOsc11("\x1b]11;rgb:1a/1b/1c\x07"), false);               // 8-bit form
  assert.equal(parseOsc11("no-osc-here"), undefined);                        // unsupported terminal
});
