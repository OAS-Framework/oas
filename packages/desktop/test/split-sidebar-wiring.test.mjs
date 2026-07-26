// Split panes + hideable sidebar — shell wiring pins (keybindings-wiring
// house style: source-level assertions without booting Electron) plus the
// engine's default chords for the new actions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KEYMAP, TERMINAL_ALLOWLIST, parseChord } from "../renderer/keybindings.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

test("split + sidebar actions have parseable default chords and terminal allowlisting", () => {
  for (const id of ["sidebar.toggle", "split.vertical", "split.horizontal", "split.close"]) {
    assert.ok(DEFAULT_KEYMAP[id], `${id} has a default chord`);
    assert.ok(parseChord(DEFAULT_KEYMAP[id]), `${id} chord parses`);
    assert.ok(TERMINAL_ALLOWLIST.includes(id),
      `${id} must fire inside xterm on Linux/Windows (the active pane IS a terminal)`);
  }
});

test("shell registers the split and sidebar actions and exposes them in the palette", () => {
  const src = read("renderer/shell.mjs");
  for (const id of ["sidebar.toggle", "split.vertical", "split.horizontal", "split.close"]) {
    assert.match(src, new RegExp(`id: "${id.replace(".", "\\.")}"`), `action ${id} registered`);
    assert.match(src, new RegExp(`chordDetail\\("${id.replace(".", "\\.")}"\\)`), `palette shows ${id}'s chord`);
  }
  // splits arrange TERMINAL tabs on the tab layer
  assert.match(src, /id: "split\.vertical", label: [^\n]*context: "tabs"/, "split actions live in the tabs context");
});

test("splits are terminal-only, absorb via activateTab, and clean up on close/workspace switch", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /if \(!t \|\| t\.kind !== "terminal"\) return; \/\/ splits are terminal-only/);
  // the pending slot fills through the SAME tab path every open uses —
  // identity resolution and dedup are untouched (soul invariant)
  assert.match(src, /split = absorbTab\(split, id\)\.split/);
  assert.match(src, /split = removeSplitTab\(split, id\)/);
  assert.match(src, /split = null; \/\/ splits are per-workspace/);
});

test("sidebar toggle is class-driven and persisted like other shell prefs", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /const SIDEBAR_HIDDEN_KEY = "oas-desktop-sidebar-hidden"/);
  assert.match(src, /classList\.toggle\("sidebar-hidden", on\)/);
  assert.match(src, /localStorage\.getItem\(SIDEBAR_HIDDEN_KEY\) === "1"/, "restored at startup");
  const css = read("renderer/shell.css");
  assert.match(css, /#app\.sidebar-hidden #sidebar \{ display: none; \}/);
});

test("split CSS turns member panes into flex cells in both orientations", () => {
  const css = read("renderer/shell.css");
  assert.match(css, /#tabhost\.split-row \{ display: flex; flex-direction: row; \}/);
  assert.match(css, /#tabhost\.split-col \{ display: flex; flex-direction: column; \}/);
  // split cells leave absolute positioning so flex can size them; xterm's
  // FitAddon then refits via each tab's ResizeObserver
  assert.match(css, /\.tab-pane\.split-cell \{ position: relative; inset: auto; flex: 1 1 0; min-width: 0; min-height: 0; \}/);
});

test("activateTab keeps single-selection a11y: only the active tab is aria-selected", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /t\.triggerEl\.setAttribute\("aria-selected", String\(selected\)\)/);
  assert.match(src, /t\.paneEl\.classList\.toggle\("active", shown\)/,
    "split members stay .active so their ResizeObservers refit");
});
