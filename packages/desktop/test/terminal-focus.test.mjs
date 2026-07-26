// Terminal focus jump (feature: jump to an instance terminal and FOCUS its
// input). Source-level pins in the keybindings-wiring house style: the
// focus-discipline invariants live in shell.mjs's activateTab plumbing
// (Electron-only composition root), so they are pinned at the source layer;
// the fresh-open path's term.focus() is behaviorally covered by
// terminal-tab.test.mjs (onReady ordering).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KEYMAP } from "../renderer/keybindings.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

test("activateTab carries an explicit focusContent intent (user jumps vs side effects)", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /function activateTab\(id, \{ focusContent = false \} = \{\}\)/,
    "focusContent defaults FALSE — side-effect activations must not steal focus");
  assert.match(src, /if \(focusContent\) tabs\.get\(id\)\?\.focusContent\?\.\(\);/,
    "content focus runs only on explicit user intent, after onShow");
});

test("terminal tabs provide focusContent = term.focus and fresh-open dedup focuses", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /focusContent: \(\) => \{ try \{ term\.focus\(\); \} catch \{\} \}/,
    "terminal tab focuses the xterm textarea");
  assert.match(src, /focusOnActivate: true/,
    "addTab's dedup inside openTerminalTabInner is a user jump");
});

test("every openTerminalTab jump path focuses the existing tab's terminal input", () => {
  const src = read("renderer/shell.mjs");
  // the already-open activation inside openTerminalTab (palette jump,
  // roster row, quick-open post-spawn) passes focusContent: true
  assert.match(src, /if \(t\.key === key\) \{ activateTab\(tid, \{ focusContent: true \}\); return; \}/);
});

test("workspace-switch restoration does NOT steal focus (side-effect activation)", () => {
  const src = read("renderer/shell.mjs");
  const restore = src.match(/const restored = restoreTerminalTab[\s\S]*?activateTab\(restored\[0\]\)([^;]*)/);
  assert.ok(restore, "restoration path present");
  assert.ok(!/focusContent/.test(restore[1]), "restoration activates without focusContent");
});

test("terminal.focusActive is a registered rebindable action with NO default chord", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /id: "terminal\.focusActive", label: [^,]+, context: "global"/,
    "editor-visible global action");
  assert.equal(DEFAULT_KEYMAP["terminal.focusActive"], undefined,
    "no default chord — Ctrl chords belong to the pty on Linux/Windows; bind in the editor");
  assert.match(src, /Terminal: focus the active terminal input/, "palette-discoverable");
  assert.match(src, /function focusActiveTerminal\(\)[\s\S]*?kind === "terminal"\) t\.focusContent\?\.\(\)/,
    "focuses only when the active tab IS a terminal");
});
