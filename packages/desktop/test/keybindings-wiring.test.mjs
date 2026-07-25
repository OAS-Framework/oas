// keybindings wiring — the shell installs ONE engine keydown listener and
// every mouse affordance is registered as a rebindable action. Source-level
// assertions in the shell-nav.test.mjs house style: they pin the wiring
// without booting Electron.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

test("shell installs exactly one window keydown listener: the engine's handleKeydown", () => {
  const src = read("renderer/shell.mjs");
  const listeners = [...src.matchAll(/window\.addEventListener\("keydown"/g)];
  assert.equal(listeners.length, 1, "ONE window keydown listener (contract)");
  // engine addendum: handleKeydown itself skips defaultPrevented events,
  // so the shell listener is a bare delegation.
  assert.match(src, /window\.addEventListener\("keydown", \(e\) => handleKeydown\(e\)\)/);
  assert.ok(!/isPaletteShortcut\(/.test(src), "ad-hoc palette shortcut check replaced by the engine");
});

test("shell registers global + tabs actions covered by the engine's DEFAULT_KEYMAP", () => {
  const src = read("renderer/shell.mjs");
  for (const id of [
    "app.palette", "app.shortcuts", "app.themeToggle", "app.workspaces", "sidebar.focusFilter",
    "terminal.fontBigger", "terminal.fontSmaller", "terminal.fontReset",
    "tabs.next", "tabs.prev", "tabs.close",
  ]) assert.match(src, new RegExp(`id: "${id.replace(".", "\\.")}"`), `action ${id} registered`);
  assert.match(src, /NAV\.forEach\(\(v\) => registerAction\(/, "stage actions derive from the nav manifest");
  assert.match(src, /setActiveContexts/, "shell drives active contexts");
});

test("hierarchy and spawn views register rebindable view-local actions and dispose them", () => {
  const hier = read("renderer/views/hierarchy.mjs");
  for (const id of ["hier.fit", "hier.terminal", "hier.brain", "hier.spawn", "hier.popover", "hier.zoomIn", "hier.zoomOut"]) {
    assert.match(hier, new RegExp(`id: "${id.replace(".", "\\.")}", defaultChord:`), `hierarchy action ${id} declared`);
  }
  assert.match(hier, /context: "view:hierarchy"/, "hierarchy actions use a never-activated view context (editor-visible, window-dispatch-ineligible — review afd2114)");
  assert.match(hier, /run: guarded\(a\.run\)|context: "view:hierarchy"/, "outside keypresses cannot be swallowed");
  assert.match(hier, /s\.disposers = s\.viewActions\.map/, "hierarchy keeps action disposers");
  assert.match(hier, /\(s\.disposers \|\| \[\]\)\.forEach/, "hierarchy disposes actions on teardown");
  assert.match(hier, /resolveViewKey\(e, s\.viewActions\)/, "canvas keys resolve through the engine keymap (rebindable)");

  const spawn = read("renderer/views/spawn.mjs");
  for (const id of ["spawn.filter", "spawn.brain"]) {
    assert.match(spawn, new RegExp(`id: "${id.replace(".", "\\.")}"`), `spawn action ${id}`);
  }
  assert.match(spawn, /context: "view:spawn"/, "spawn actions use the never-activated view context");
  assert.match(spawn, /resolveViewKey\(/, "spawn keys resolve through the engine keymap");
  assert.match(spawn, /\(state\.disposers \|\| \[\]\)\.forEach/, "spawn disposes actions on unmount");
});

test("palette rows and data-action tooltips carry live chord labels", () => {
  const shell = read("renderer/shell.mjs");
  assert.match(shell, /detail: chordDetail\(/, "palette commands show the current chord");
  assert.match(shell, /onKeymapChange\(\(\) => applyChordTitles\(\)\)/, "tooltips live-update on rebinding");
  const palette = read("renderer/palette.mjs");
  assert.match(palette, /typeof c\.detail === "function" \? c\.detail\(\)/, "palette re-evaluates chord details per render");
});

test("view-local defaults are first-class engine bindings (registerAction defaultChord)", () => {
  // engine addendum 3: dynamic view actions carry their default in the
  // registration; getBinding folds override ?? DEFAULT_KEYMAP ?? defaultChord,
  // so the editor shows real defaults and Backspace-unbind kills the key.
  const hier = read("renderer/views/hierarchy.mjs");
  const expected = {
    "hier.fit": "F", "hier.terminal": "T", "hier.brain": "B", "hier.spawn": "S",
    "hier.popover": "O", "hier.zoomIn": "=", "hier.zoomOut": "-",
  };
  for (const [id, chord] of Object.entries(expected)) {
    assert.match(hier, new RegExp(`id: "${id.replace(".", "\\.")}", defaultChord: "${chord === "=" ? "=" : chord}"`),
      `${id} registers defaultChord ${chord}`);
  }
  assert.match(hier, /registerAction\(\{\n?\s*id: a\.id,.*defaultChord: a\.defaultChord,?\n?\s*\}\)/s,
    "hierarchy passes defaultChord through registerAction");
  const spawn = read("renderer/views/spawn.mjs");
  assert.match(spawn, /id: "spawn\.filter", label:.*defaultChord: "\/"/, "spawn.filter default '/'");
  assert.match(spawn, /id: "spawn\.brain", label:.*defaultChord: "B"/, "spawn.brain default B");
});
