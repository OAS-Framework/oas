// keybindings engine (transitional stub) — contract + terminal-safety policy.
// These tests pin the CONTRACT the wiring codes against; the core engine
// replacing the stub must keep them green (or supersede them with its own).
import test from "node:test";
import assert from "node:assert/strict";

// The module reads navigator/localStorage lazily; provide minimal globals.
globalThis.navigator ??= { platform: "TestOS" };
globalThis.localStorage ??= (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();

const kb = await import("../renderer/keybindings.mjs");

const ev = (key, mods = {}, target = null) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  target, preventDefault() { this.defaultPrevented = true; },
  ...mods,
});

test.beforeEach(() => {
  kb._resetForTests();
  localStorage.removeItem("oas.keybindings");
});

test("parseChord handles modifiers and literal +/- keys", () => {
  assert.deepEqual(kb.parseChord("Mod+K"), { key: "k", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(kb.parseChord("Mod+Shift+K"), { key: "k", mod: true, ctrl: false, alt: false, shift: true });
  assert.equal(kb.parseChord("Mod++").key, "+");
  assert.equal(kb.parseChord("+").key, "+");
  assert.equal(kb.parseChord("-").key, "-");
  assert.equal(kb.parseChord(""), null);
});

test("formatChord: mac glyphs vs win/linux labels", () => {
  assert.equal(kb.formatChord("Mod+K", true), "⌘K");
  assert.equal(kb.formatChord("Mod+K", false), "Ctrl+K");
  assert.equal(kb.formatChord("Mod+Shift+K", true), "⇧⌘K");
  assert.equal(kb.formatChord("Mod+Shift+K", false), "Ctrl+Shift+K");
  assert.equal(kb.formatChord("b", false), "B");
});

test("matchesChord preserves the shipped palette terminal policy for Mod+K", () => {
  // Cmd-K on mac: always (even inside terminal)
  assert.equal(kb.matchesChord(ev("k", { metaKey: true }), "Mod+K", { isMac: true, insideTerminal: true }), true);
  // Ctrl-K on win/linux: outside terminal only
  assert.equal(kb.matchesChord(ev("k", { ctrlKey: true }), "Mod+K", { isMac: false, insideTerminal: false }), true);
  assert.equal(kb.matchesChord(ev("k", { ctrlKey: true }), "Mod+K", { isMac: false, insideTerminal: true }), false);
  // Ctrl-K on mac outside terminal: accepted fallback (matches isPaletteShortcut)
  assert.equal(kb.matchesChord(ev("k", { ctrlKey: true }), "Mod+K", { isMac: true, insideTerminal: false }), true);
  // extra modifiers do not match
  assert.equal(kb.matchesChord(ev("k", { ctrlKey: true, shiftKey: true }), "Mod+K", { isMac: false }), false);
  assert.equal(kb.matchesChord(ev("k", { ctrlKey: true, altKey: true }), "Mod+K", { isMac: false }), false);
});

test("matchesChord: unmodified single keys never fire in editable fields or terminals", () => {
  assert.equal(kb.matchesChord(ev("b"), "b", { isMac: false }), true);
  assert.equal(kb.matchesChord(ev("b"), "b", { isMac: false, editable: true }), false);
  assert.equal(kb.matchesChord(ev("b"), "b", { isMac: false, insideTerminal: true }), false);
});

test("registerAction + handleKeydown dispatch respects contexts", () => {
  const fired = [];
  kb.registerAction({ id: "app.palette", label: "Palette", context: "global", chord: "Mod+K", run: () => fired.push("palette") });
  kb.registerAction({ id: "hier.fit", label: "Fit", context: "stage:hierarchy", chord: "f", run: () => fired.push("fit") });

  kb.setActiveContexts(new Set(["stage:spawn"]));
  assert.equal(kb.handleKeydown(ev("f"), { isMac: false }), false, "inactive context does not fire");
  assert.equal(kb.handleKeydown(ev("k", { ctrlKey: true }), { isMac: false }), true, "global fires in any context");

  kb.setActiveContexts(new Set(["stage:hierarchy"]));
  assert.equal(kb.handleKeydown(ev("f"), { isMac: false }), true);
  assert.deepEqual(fired, ["palette", "fit"]);
});

test("dispose from registerAction removes the action", () => {
  const off = kb.registerAction({ id: "x", chord: "x", run: () => {} });
  assert.equal(kb.getBinding("x"), "x");
  off();
  assert.equal(kb.getBinding("x"), null);
});

test("localStorage overrides rebind and notify listeners", () => {
  let notified = 0;
  kb.registerAction({ id: "app.theme", chord: "Mod+Shift+L", run: () => {} });
  const off = kb.onKeymapChange(() => notified++);
  kb.setBinding("app.theme", "Mod+T");
  assert.equal(kb.getBinding("app.theme"), "Mod+T");
  assert.equal(kb.handleKeydown(ev("t", { ctrlKey: true }), { isMac: false }), true);
  assert.equal(kb.handleKeydown(ev("l", { ctrlKey: true, shiftKey: true }), { isMac: false }), false, "default chord unbound after override");
  kb.setBinding("app.theme", null); // explicit unbind
  assert.equal(kb.getBinding("app.theme"), null);
  kb.setBinding("app.theme", undefined); // reset to default
  assert.equal(kb.getBinding("app.theme"), "Mod+Shift+L");
  assert.ok(notified >= 3);
  off();
});

test("handleKeydown derives terminal/editable safety from the event target", () => {
  let fired = 0;
  kb.registerAction({ id: "roster.focus", chord: "Mod+Shift+E", run: () => fired++ });
  kb.registerAction({ id: "hier.brain", context: "stage:hierarchy", chord: "b", run: () => fired++ });
  kb.setActiveContexts(new Set(["stage:hierarchy"]));
  const termTarget = { closest: (sel) => (sel === ".xterm" ? {} : null), tagName: "DIV" };
  const inputTarget = { closest: () => null, tagName: "INPUT" };
  assert.equal(kb.handleKeydown(ev("b", {}, termTarget), { isMac: false }), false, "plain key inside terminal passes through");
  assert.equal(kb.handleKeydown(ev("b", {}, inputTarget), { isMac: false }), false, "plain key in input types text");
  assert.equal(kb.handleKeydown(ev("e", { ctrlKey: true, shiftKey: true }, inputTarget), { isMac: false }), true, "modified chord fires from input");
  assert.equal(fired, 1);
});
