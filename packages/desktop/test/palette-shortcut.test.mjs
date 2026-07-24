import test from "node:test";
import assert from "node:assert/strict";
import { isPaletteShortcut } from "../renderer/palette.mjs";

const key = (overrides = {}) => ({
  key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  ...overrides,
});

test("palette shortcut: Cmd-K works; Ctrl-K works outside xterm only", () => {
  assert.equal(isPaletteShortcut(key({ metaKey: true }), false), true);
  assert.equal(isPaletteShortcut(key({ ctrlKey: true }), false), true,
    "Windows/Linux Ctrl-K opens palette outside terminal");
  assert.equal(isPaletteShortcut(key({ ctrlKey: true }), true), false,
    "Ctrl-K inside xterm must pass through to the attached program");
  assert.equal(isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(isPaletteShortcut(key({ key: "b", ctrlKey: true }), false), false);
});
