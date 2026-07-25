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
  assert.match(src, /window\.addEventListener\("keydown", \(e\) => \{ if \(!e\.defaultPrevented\) handleKeydown\(e\); \}\)/);
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
    assert.match(hier, new RegExp(`id: "${id.replace(".", "\\.")}", label:.*context: "stage:hierarchy"`), `hierarchy action ${id}`);
  }
  assert.match(hier, /s\.disposers = \[/, "hierarchy keeps action disposers");
  assert.match(hier, /\(s\.disposers \|\| \[\]\)\.forEach/, "hierarchy disposes actions on teardown");

  const spawn = read("renderer/views/spawn.mjs");
  for (const id of ["spawn.filter", "spawn.brain"]) {
    assert.match(spawn, new RegExp(`id: "${id.replace(".", "\\.")}", label:.*context: "stage:spawn"`), `spawn action ${id}`);
  }
  assert.match(spawn, /\(state\.disposers \|\| \[\]\)\.forEach/, "spawn disposes actions on unmount");
});

test("palette rows and data-action tooltips carry live chord labels", () => {
  const shell = read("renderer/shell.mjs");
  assert.match(shell, /detail: chordDetail\(/, "palette commands show the current chord");
  assert.match(shell, /onKeymapChange\(\(\) => applyChordTitles\(\)\)/, "tooltips live-update on rebinding");
  const palette = read("renderer/palette.mjs");
  assert.match(palette, /typeof c\.detail === "function" \? c\.detail\(\)/, "palette re-evaluates chord details per render");
});

test("hierarchy canvas keys cover the completed set (b/t/s/o/+/-)", () => {
  const hier = read("renderer/views/hierarchy.mjs");
  assert.match(hier, /e\.key === "Enter" \|\| e\.key === "t"/, "t is a terminal synonym of Enter");
  for (const k of ['e.key === "b"', 'e.key === "s"', 'e.key === "o"', 'e.key === "+"', 'e.key === "-"']) {
    assert.ok(hier.includes(k), `canvas handles ${k}`);
  }
});
