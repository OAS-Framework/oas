import test from "node:test";
import assert from "node:assert/strict";
import {
  parseChord, formatChord, chordToString, chordFromEvent, normalizeKey,
  DEFAULT_KEYMAP, TERMINAL_ALLOWLIST, CONTEXTS,
  registerAction, listActions, setActiveContexts,
  getBinding, setBinding, resetBinding, resetAllBindings, onKeymapChange,
  matchEvent, handleKeydown, findConflict,
} from "../renderer/keybindings.mjs";

// Minimal localStorage stub — the engine must survive without it too.
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}
installStorage();

const ev = (key, overrides = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  preventDefault() { this.defaultPrevented = true; },
  ...overrides,
});

// ---------------------------------------------------------------- chords

test("parseChord handles modifiers, aliases, and the Mod+= edge", () => {
  assert.deepEqual(parseChord("Mod+Shift+K"), { key: "k", mod: true, ctrl: false, alt: false, shift: true });
  assert.deepEqual(parseChord("Ctrl+Tab"), { key: "tab", mod: false, ctrl: true, alt: false, shift: false });
  assert.deepEqual(parseChord("Mod+="), { key: "=", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseChord("Mod+-"), { key: "-", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseChord("Mod+,"), { key: ",", mod: true, ctrl: false, alt: false, shift: false });
  assert.equal(parseChord("Mod+Shift"), null, "a chord needs a non-modifier key");
  assert.equal(parseChord(""), null);
  assert.equal(parseChord(null), null);
  assert.equal(parseChord("A+B"), null, "two main keys is invalid");
});

test("every DEFAULT_KEYMAP entry parses and round-trips through chordToString", () => {
  for (const [id, chord] of Object.entries(DEFAULT_KEYMAP)) {
    const parsed = parseChord(chord);
    assert.ok(parsed, `${id}: ${chord} must parse`);
    assert.deepEqual(parseChord(chordToString(parsed)), parsed, `${id}: round-trip`);
  }
});

test("formatChord: mac symbols vs Ctrl-style labels", () => {
  assert.equal(formatChord("Mod+Shift+K", true), "⇧⌘K");
  assert.equal(formatChord("Mod+Shift+K", false), "Ctrl+Shift+K");
  assert.equal(formatChord("Ctrl+Tab", true), "⌃Tab");
  assert.equal(formatChord("Ctrl+Tab", false), "Ctrl+Tab");
  assert.equal(formatChord("Mod+=", false), "Ctrl+=");
  assert.equal(formatChord(null, true), "");
});

test("chordFromEvent maps the platform Mod correctly and normalizes keys", () => {
  assert.deepEqual(chordFromEvent(ev("k", { metaKey: true }), true),
    { key: "k", mod: true, ctrl: false, alt: false, shift: false });
  assert.deepEqual(chordFromEvent(ev("k", { ctrlKey: true }), false),
    { key: "k", mod: true, ctrl: false, alt: false, shift: false });
  assert.equal(chordFromEvent(ev("Meta", { metaKey: true }), true), null, "bare modifier is not a chord");
  assert.equal(normalizeKey("+"), "=");
  assert.equal(normalizeKey("Escape"), "escape");
});

// ---------------------------------------------------------------- persistence

test("overrides persist to localStorage and reset cleanly", () => {
  const store = installStorage();
  resetAllBindings();
  assert.equal(getBinding("app.palette"), "Mod+K");
  setBinding("app.palette", "Mod+P");
  assert.equal(getBinding("app.palette"), "Mod+P");
  assert.match(store.get("oas-desktop-keymap"), /Mod\+P/);
  setBinding("tabs.close", null); // explicit unbind
  assert.equal(getBinding("tabs.close"), null);
  resetBinding("app.palette");
  assert.equal(getBinding("app.palette"), "Mod+K");
  resetAllBindings();
  assert.equal(getBinding("tabs.close"), "Mod+W");
  assert.equal(store.has("oas-desktop-keymap"), false, "empty overrides remove the key");
});

test("storage-less environments do not throw", () => {
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    assert.doesNotThrow(() => { setBinding("app.palette", "Mod+P"); resetAllBindings(); });
  } finally { globalThis.localStorage = saved; }
});

test("onKeymapChange fires on set/reset and unsubscribes", () => {
  installStorage(); resetAllBindings();
  let calls = 0;
  const off = onKeymapChange(() => calls++);
  setBinding("app.palette", "Mod+P");
  resetBinding("app.palette");
  off();
  setBinding("app.palette", "Mod+P");
  assert.equal(calls, 2);
  resetAllBindings();
});

// ---------------------------------------------------------------- dispatch

function withActions(t, actions) {
  installStorage(); resetAllBindings();
  const offs = actions.map((a) => registerAction(a));
  setActiveContexts(new Set());
  t.after(() => { for (const off of offs) off(); resetAllBindings(); });
}

test("matchEvent: global action fires on its default chord (mac + non-mac)", (t) => {
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: false }), "app.palette");
  assert.equal(matchEvent(ev("k", { ctrlKey: true }), { isMac: false, insideTerminal: false }), "app.palette");
  assert.equal(matchEvent(ev("k"), { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent(ev("k", { metaKey: true, shiftKey: true }), { isMac: true, insideTerminal: false }), null,
    "extra modifiers must not match");
});

test("matchEvent: context scoping — non-global actions need an active context", (t) => {
  withActions(t, [{ id: "stage.hierarchy.focus", label: "Focus", context: "stage:hierarchy", run: () => {} }]);
  setBinding("stage.hierarchy.focus", "Mod+J");
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), null);
  setActiveContexts(new Set(["stage:hierarchy"]));
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), "stage.hierarchy.focus");
});

test("matchEvent: a context action beats a global action on the same chord", (t) => {
  withActions(t, [
    { id: "g.act", label: "Global", context: "global", run: () => {} },
    { id: "t.act", label: "Tabs", context: "tabs", run: () => {} },
  ]);
  setBinding("g.act", "Mod+J");
  setBinding("t.act", "Mod+J");
  setActiveContexts(new Set(["tabs"]));
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), "t.act");
  setActiveContexts(new Set());
  assert.equal(matchEvent(ev("j", { metaKey: true }), { isMac: true, insideTerminal: false }), "g.act");
});

test("terminal policy mac: only ⌘-resolved chords fire inside xterm", (t) => {
  withActions(t, [
    { id: "app.palette", label: "Palette", context: "global", run: () => {} },
    { id: "tabs.next", label: "Next", context: "global", run: () => {} },
    { id: "x.ctrl", label: "Explicit ctrl", context: "global", run: () => {} },
  ]);
  setBinding("x.ctrl", "Ctrl+B");
  // ⌘K fires inside terminal
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: true }), "app.palette");
  // Ctrl+Tab (tabs.next default) must NOT fire inside terminal on mac — Ctrl belongs to the pty
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true }), { isMac: true, insideTerminal: true }), null);
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true }), { isMac: true, insideTerminal: false }), "tabs.next");
  // explicit Ctrl chord never fires inside terminal on mac (tmux prefix etc.)
  assert.equal(matchEvent(ev("b", { ctrlKey: true }), { isMac: true, insideTerminal: true }), null);
  assert.equal(matchEvent(ev("b", { ctrlKey: true }), { isMac: true, insideTerminal: false }), "x.ctrl");
});

test("terminal policy non-mac: only allowlisted action ids fire inside xterm", (t) => {
  withActions(t, [
    { id: "app.palette", label: "Palette", context: "global", run: () => {} },
    { id: "tabs.next", label: "Next", context: "global", run: () => {} },
    { id: "tabs.prev", label: "Prev", context: "global", run: () => {} },
    { id: "tabs.close", label: "Close", context: "global", run: () => {} },
    { id: "app.themeToggle", label: "Theme", context: "global", run: () => {} },
  ]);
  const inTerm = { isMac: false, insideTerminal: true };
  assert.equal(matchEvent(ev("k", { ctrlKey: true }), inTerm), "app.palette");
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true }), inTerm), "tabs.next");
  assert.equal(matchEvent(ev("Tab", { ctrlKey: true, shiftKey: true }), inTerm), "tabs.prev");
  assert.equal(matchEvent(ev("w", { ctrlKey: true }), inTerm), "tabs.close");
  // Ctrl+Shift+T (theme) is NOT allowlisted — belongs to the attached program
  assert.equal(matchEvent(ev("t", { ctrlKey: true, shiftKey: true }), inTerm), null);
  assert.equal(matchEvent(ev("t", { ctrlKey: true, shiftKey: true }), { isMac: false, insideTerminal: false }), "app.themeToggle");
  // allowlist is action-id based, so it follows a rebind
  setBinding("app.palette", "Ctrl+P");
  assert.equal(matchEvent(ev("p", { ctrlKey: true }), inTerm), "app.palette");
  assert.equal(matchEvent(ev("k", { ctrlKey: true }), inTerm), null, "old chord no longer bound");
});

test("engine absorbs the palette chord: parity with isPaletteShortcut except the task's Linux allowlist", async (t) => {
  const { isPaletteShortcut } = await import("../renderer/palette.mjs");
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  const cases = [
    [ev("k", { metaKey: true }), true, false], [ev("k", { metaKey: true }), true, true],
    [ev("k", { ctrlKey: true }), false, false],
    [ev("k", { ctrlKey: true, shiftKey: true }), false, false],
    [ev("b", { ctrlKey: true }), false, false],
    [ev("k", { metaKey: true, altKey: true }), true, false],
  ];
  for (const [e, isMac, insideTerminal] of cases) {
    const legacy = isPaletteShortcut(e, insideTerminal);
    const engine = matchEvent(e, { isMac, insideTerminal }) === "app.palette";
    assert.equal(engine, legacy,
      `parity for key=${e.key} meta=${!!e.metaKey} ctrl=${!!e.ctrlKey} shift=${!!e.shiftKey} alt=${!!e.altKey} mac=${isMac} term=${insideTerminal}`);
  }
  // Deliberate divergence per the keybindings contract: on Linux/Windows the
  // palette chord is allowlisted INSIDE the terminal (legacy passed it through).
  assert.equal(isPaletteShortcut(ev("k", { ctrlKey: true }), true), false);
  assert.equal(matchEvent(ev("k", { ctrlKey: true }), { isMac: false, insideTerminal: true }), "app.palette");
});

test("handleKeydown runs the action, preventDefaults, and isolates errors", (t) => {
  let ran = 0;
  withActions(t, [
    { id: "app.palette", label: "Palette", context: "global", run: () => { ran++; } },
    { id: "x.boom", label: "Boom", context: "global", run: () => { throw new Error("boom"); } },
  ]);
  setBinding("x.boom", "Mod+B");
  const e1 = ev("k", { metaKey: true });
  assert.equal(handleKeydown(e1, { isMac: true, insideTerminal: false }), true);
  assert.equal(ran, 1);
  assert.equal(e1.defaultPrevented, true);
  const e2 = ev("b", { metaKey: true });
  assert.doesNotThrow(() => handleKeydown(e2, { isMac: true, insideTerminal: false }));
  assert.equal(e2.defaultPrevented, true);
  const e3 = ev("z");
  assert.equal(handleKeydown(e3, { isMac: true, insideTerminal: false }), false);
  assert.equal(e3.defaultPrevented, undefined);
});

test("unbound actions never match; rebinding is honored by dispatch", (t) => {
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  setBinding("app.palette", null);
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: false }), null);
  setBinding("app.palette", "Mod+Shift+P");
  assert.equal(matchEvent(ev("p", { metaKey: true, shiftKey: true }), { isMac: true, insideTerminal: false }), "app.palette");
});

test("matchEvent ignores events already consumed via preventDefault", (t) => {
  withActions(t, [{ id: "app.palette", label: "Palette", context: "global", run: () => {} }]);
  const e = ev("k", { metaKey: true });
  e.preventDefault();
  assert.equal(matchEvent(e, { isMac: true, insideTerminal: false }), null,
    "a defaultPrevented event must never dispatch");
  assert.equal(handleKeydown(ev("k", { metaKey: true, defaultPrevented: true }), { isMac: true, insideTerminal: false }), false);
  // and the unconsumed event still works
  assert.equal(matchEvent(ev("k", { metaKey: true }), { isMac: true, insideTerminal: false }), "app.palette");
});

test("unmodified chords do not fire from editable fields; modified chords do", (t) => {
  withActions(t, [
    { id: "hier.filter", label: "Filter", context: "stage:hierarchy", run: () => {} },
    { id: "app.palette", label: "Palette", context: "global", run: () => {} },
  ]);
  setActiveContexts(new Set(["stage:hierarchy"]));
  setBinding("hier.filter", "F");
  const opts = (editableTarget) => ({ isMac: true, insideTerminal: false, editableTarget });
  // plain key: fires outside editables, not inside
  assert.equal(matchEvent(ev("f"), opts(false)), "hier.filter");
  assert.equal(matchEvent(ev("f"), opts(true)), null, "plain chord must not steal typing");
  // shift-only counts as unmodified (typing produces shifted chars)
  setBinding("hier.filter", "Shift+F");
  assert.equal(matchEvent(ev("f", { shiftKey: true }), opts(true)), null);
  assert.equal(matchEvent(ev("f", { shiftKey: true }), opts(false)), "hier.filter");
  // modified chords still fire from editable fields
  assert.equal(matchEvent(ev("k", { metaKey: true }), opts(true)), "app.palette");
  // default editable detection from e.target (tagName / contentEditable)
  setBinding("hier.filter", "F");
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "INPUT" } }, { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "TEXTAREA" } }, { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "DIV", isContentEditable: true } }, { isMac: true, insideTerminal: false }), null);
  assert.equal(matchEvent({ ...ev("f"), target: { tagName: "DIV" } }, { isMac: true, insideTerminal: false }), "hier.filter");
});

test("registerAction defaultChord: folds into the effective keymap (addendum 3)", (t) => {
  installStorage(); resetAllBindings();
  const off = registerAction({ id: "hier.fit", label: "Fit", context: "stage:hierarchy", run: () => {}, defaultChord: "F" });
  t.after(() => { off(); resetAllBindings(); setActiveContexts(new Set()); });

  // registration-supplied default visible via getBinding (canonicalized)
  assert.equal(getBinding("hier.fit"), "F");

  // dispatches like any binding (context active, outside editables)
  setActiveContexts(new Set(["stage:hierarchy"]));
  assert.equal(matchEvent(ev("f"), { isMac: true, insideTerminal: false, editableTarget: false }), "hier.fit");

  // user override wins
  setBinding("hier.fit", "Mod+F");
  assert.equal(getBinding("hier.fit"), "Mod+F");
  assert.equal(matchEvent(ev("f"), { isMac: true, insideTerminal: false, editableTarget: false }), null);
  assert.equal(matchEvent(ev("f", { metaKey: true }), { isMac: true, insideTerminal: false }), "hier.fit");

  // reset returns to the registration default
  resetBinding("hier.fit");
  assert.equal(getBinding("hier.fit"), "F");

  // explicit null unbind kills the default and stops dispatch
  setBinding("hier.fit", null);
  assert.equal(getBinding("hier.fit"), null);
  assert.equal(matchEvent(ev("f"), { isMac: true, insideTerminal: false, editableTarget: false }), null);

  // …and the unbind survives a storage reload (persisted null round-trips)
  const raw = localStorage.getItem("oas-desktop-keymap");
  assert.match(raw, /"hier\.fit":null/);

  // static DEFAULT_KEYMAP wins over a registration default for the same id
  const off2 = registerAction({ id: "app.palette", label: "P", context: "global", run: () => {}, defaultChord: "Mod+9" });
  assert.equal(getBinding("app.palette"), "Mod+K");
  off2();

  // invalid defaultChord is discarded, not thrown
  const off3 = registerAction({ id: "x.bad", label: "Bad", context: "global", run: () => {}, defaultChord: "A+B" });
  assert.equal(getBinding("x.bad"), null);
  off3();
});

test("registerAction defaultChord: unbind persisted across module reload; conflicts seen", async (t) => {
  installStorage(); resetAllBindings();
  localStorage.setItem("oas-desktop-keymap", JSON.stringify({ "hier.fit": null }));
  const fresh = await import("../renderer/keybindings.mjs?fresh=" + Math.random());
  const off = fresh.registerAction({ id: "hier.fit", label: "Fit", context: "stage:hierarchy", run: () => {}, defaultChord: "F" });
  t.after(() => { off(); fresh.resetAllBindings(); });
  assert.equal(fresh.getBinding("hier.fit"), null,
    "explicit unbind loaded from storage suppresses the registration default");

  // findConflict treats a registration default like any binding
  fresh.resetAllBindings();
  assert.equal(fresh.getBinding("hier.fit"), "F");
  assert.equal(fresh.findConflict("F", "stage:hierarchy", null, true)?.id, "hier.fit");
  assert.equal(fresh.findConflict("F", "tabs", null, true), null, "other non-global context: no conflict");
});

// ---------------------------------------------------------------- conflicts

test("findConflict: same context and global<->context collisions, exclusion", (t) => {
  withActions(t, [
    { id: "g.one", label: "One", context: "global", run: () => {} },
    { id: "t.two", label: "Two", context: "tabs", run: () => {} },
    { id: "h.three", label: "Three", context: "stage:hierarchy", run: () => {} },
  ]);
  setBinding("g.one", "Mod+J");
  setBinding("t.two", "Mod+L");
  setBinding("h.three", "Mod+L");
  // global chord vs context binding
  assert.equal(findConflict("Mod+J", "tabs", null, true)?.id, "g.one");
  // same-context conflict
  assert.equal(findConflict("Mod+L", "tabs", null, true)?.id, "t.two");
  // different non-global contexts never both fire — no conflict
  assert.equal(findConflict("Mod+L", "stage:spawn", null, true), null);
  // excluding the action being edited
  assert.equal(findConflict("Mod+L", "tabs", "t.two", true), null);
  // no conflict for a free chord
  assert.equal(findConflict("Mod+Shift+9", "global", null, true), null);
  // non-mac folding: Ctrl+J collides with Mod+J
  assert.equal(findConflict("Ctrl+J", "global", null, false)?.id, "g.one");
});

test("registry basics: contexts constant, list/unregister", (t) => {
  assert.deepEqual([...CONTEXTS], ["global", "stage:hierarchy", "stage:spawn", "roster", "tabs"]);
  assert.ok(TERMINAL_ALLOWLIST.includes("app.palette"));
  const off = registerAction({ id: "tmp.x", label: "X", context: "tabs", run: () => {} });
  assert.ok(listActions().some((a) => a.id === "tmp.x"));
  off();
  assert.ok(!listActions().some((a) => a.id === "tmp.x"));
  assert.throws(() => registerAction({ id: "", run: () => {} }));
  assert.throws(() => registerAction({ id: "y" }));
});
