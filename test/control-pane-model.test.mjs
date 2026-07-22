import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConstellation, parseGitDiffStat, parseGitStatus, parseTmuxWindows, readMarkdownSection, relativeAge,
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

test("renderFrame never exposes the terminal's own colors", () => {
  const instance = {
    instance: "worker", agent: "builder", running: true, createdAt: new Date().toISOString(),
    next: "Run the verification suite", task: "Build the pane", git: { branch: "feat/pane", dirty: 1, ahead: 0, behind: 0 },
    runtime: "pi", work: "worktree", command: "node", knowledgeCount: 7, home: "/tmp/worker",
    tmux: { session: "pi-agents", window: "worker" },
  };
  const snapshot = { root: "/tmp/demo/agents", generatedAt: new Date().toISOString(), instances: [instance], rows: [{ instance, depth: 0, ancestorsLast: [], last: true }], running: 1, soulCount: 1, tmuxAvailable: true };
  const frame = renderFrame(snapshot, { selected: 0, preview: "\x1b[0mreset\x1b[m short\x1b[0;31mcompound\x1b[39m\x1b[49mdefaults" }, 100, 24);
  for (const row of frame.text.split("\n")) {
    // Every row must open with an explicit theme background before any glyph.
    assert.match(row, /^\x1b\[48;2;/, "row must start with a truecolor background");
    // After any SGR carrying a reset/default (0, empty, 39, 49), an explicit
    // theme color must follow before the next printable glyph.
    for (const m of row.matchAll(/\x1b\[[0-9;:]*m(?:\x1b\[[0-9;:]*m)*/g)) {
      const params = m[0].match(/^\x1b\[([0-9;:]*)m/)[1];
      const parts = params === "" ? ["0"] : params.split(";");
      if (!(parts.includes("0") || parts.includes("39") || parts.includes("49"))) continue;
      const tail = row.slice(m.index + m[0].length);
      if (!tail || /^\s*$/.test(tail.replace(/\x1b\[[0-9;:]*m/g, ""))) continue; // row end
      assert.match(m[0], /\x1b\[[34]8;2;/, `bare reset leaks terminal colors: ${JSON.stringify(m[0])}`);
    }
  }
});

test("control pane themes: named set, no terminal guessing", async () => {
  const { THEMES, startControlPane } = await import("../lib/control-pane/tui.mjs");
  assert.deepEqual(THEMES, ["dark", "solarized"]);
  await assert.rejects(() => startControlPane("/nonexistent", { theme: "disco" }), /unknown theme/);
});
