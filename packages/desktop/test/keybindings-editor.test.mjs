import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  registerAction, setBinding, resetAllBindings, getBinding, DEFAULT_KEYMAP,
} from "../renderer/keybindings.mjs";
import { createKeybindingsEditor, groupActions } from "../renderer/keybindings-editor.mjs";

// storage stub so overrides work in node
const map = new Map();
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
};

const key = (doc, key, overrides = {}) =>
  new doc.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...overrides });

function setup(t) {
  const dom = new JSDOM("<!doctype html><body>");
  const doc = dom.window.document;
  resetAllBindings();
  const offs = [
    registerAction({ id: "app.palette", label: "Command palette", context: "global", run: () => {} }),
    registerAction({ id: "tabs.close", label: "Close tab", context: "tabs", run: () => {} }),
    registerAction({ id: "stage.hierarchy.focus", label: "Focus tree", context: "stage:hierarchy", run: () => {} }),
    registerAction({ id: "hier.fit", label: "Fit to screen", context: "stage:hierarchy", run: () => {}, defaultChord: "F" }),
  ];
  t.after(() => { for (const off of offs) off(); resetAllBindings(); dom.window.close(); });
  return { dom, doc, editor: createKeybindingsEditor({ doc, isMac: true }) };
}

test("groupActions groups by context in stable order with labels", (t) => {
  const { } = setup(t);
  const groups = groupActions();
  assert.deepEqual(groups.map((g) => g.context), ["global", "tabs", "stage:hierarchy"]);
  assert.equal(groups[0].label, "Global");
  assert.equal(groups[2].label, "Active overview");
});

test("editor renders an ARIA dialog listing every action with effective chords", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const dialog = doc.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const rows = [...doc.querySelectorAll(".kb-row")];
  assert.equal(rows.length, 4);
  const labels = rows.map((r) => r.querySelector(".kb-label").textContent);
  assert.ok(labels.includes("Command palette"));
  const paletteRow = rows.find((r) => r.querySelector(".kb-label").textContent === "Command palette");
  assert.equal(paletteRow.querySelector(".kb-chord").textContent, "⌘K");
  // unregistered-default action of stage context shows "unbound" (no default for it)
  const treeRow = rows.find((r) => r.querySelector(".kb-label").textContent === "Focus tree");
  assert.equal(treeRow.querySelector(".kb-chord").textContent, "unbound");
  assert.ok(treeRow.querySelector(".kb-chord").classList.contains("kb-unbound"));
  editor.close();
  assert.equal(doc.querySelector(".kb-overlay"), null);
});

test("recording: keydown sets the binding; Esc cancels; Backspace unbinds", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);

  // record a new chord
  rowFor("Command palette").querySelector(".kb-chord").click();
  assert.match(rowFor("Command palette")?.querySelector(".kb-chord").textContent ?? doc.querySelector(".kb-recording").textContent, /Press keys/);
  doc.dispatchEvent(key(doc, "p", { metaKey: true, shiftKey: true }));
  assert.equal(getBinding("app.palette"), "Mod+Shift+P");
  assert.equal(rowFor("Command palette").querySelector(".kb-chord").textContent, "⇧⌘P");

  // Esc cancels without changing the binding
  rowFor("Close tab").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "Escape"));
  assert.equal(getBinding("tabs.close"), DEFAULT_KEYMAP["tabs.close"]);
  assert.ok(doc.querySelector('[role="dialog"]'), "Esc during recording must not close the dialog");

  // Backspace unbinds
  rowFor("Close tab").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "Backspace"));
  assert.equal(getBinding("tabs.close"), null);
  assert.equal(rowFor("Close tab").querySelector(".kb-chord").textContent, "unbound");
  editor.close();
});

test("conflict warning appears when a recorded chord collides", (t) => {
  const { doc, editor } = setup(t);
  setBinding("app.palette", "Mod+J");
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  rowFor("Close tab").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "j", { metaKey: true }));
  // after re-render the row shows the persistent conflict computed from findConflict
  assert.match(rowFor("Close tab").querySelector(".kb-conflict").textContent, /Command palette/);
  editor.close();
});

test("recording a bare key shows the editable-field warning on the row", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  rowFor("Focus tree").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "b"));
  assert.equal(getBinding("stage.hierarchy.focus"), "B");
  assert.match(rowFor("Focus tree").querySelector(".kb-conflict").textContent,
    /won’t fire while typing/, "bare-key binding warns about the editable-field guard");
  // shift-only is still a bare key
  rowFor("Focus tree").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "b", { shiftKey: true }));
  assert.match(rowFor("Focus tree").querySelector(".kb-conflict").textContent, /won’t fire while typing/);
  // a modified chord clears the warning
  rowFor("Focus tree").querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "b", { metaKey: true }));
  assert.equal(rowFor("Focus tree").querySelector(".kb-conflict").textContent, "");
  // a bare chord that ALSO conflicts shows BOTH messages (review c5493b1)
  setBinding("app.palette", "B"); // global → conflicts with any context
  setBinding("stage.hierarchy.focus", "B");
  const both = rowFor("Focus tree").querySelector(".kb-conflict").textContent;
  assert.match(both, /Command palette/, "conflict disclosed");
  assert.match(both, /won’t fire while typing/, "editable-field suppression still disclosed");
  editor.close();
});

test("per-row reset and reset-all restore defaults", (t) => {
  const { doc, editor } = setup(t);
  setBinding("app.palette", "Mod+P");
  setBinding("tabs.close", "Mod+X");
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  const paletteReset = rowFor("Command palette").querySelector(".kb-reset");
  assert.equal(paletteReset.hidden, false, "overridden row shows reset");
  paletteReset.click();
  assert.equal(getBinding("app.palette"), "Mod+K");
  assert.equal(rowFor("Command palette").querySelector(".kb-reset").hidden, true, "default row hides reset");
  doc.querySelector(".kb-reset-all").click();
  assert.equal(getBinding("tabs.close"), "Mod+W");
  editor.close();
});

test("registration defaultChord displays honestly and Backspace-unbind disables dispatch", async (t) => {
  const { doc, editor } = setup(t);
  const { matchEvent } = await import("../renderer/keybindings.mjs");
  const { setActiveContexts } = await import("../renderer/keybindings.mjs");
  setActiveContexts(new Set(["stage:hierarchy"]));
  t.after(() => setActiveContexts(new Set()));
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);
  const row = rowFor("Fit to screen");
  assert.equal(row.querySelector(".kb-chord").textContent, "F", "registration default shown, not 'unbound'");
  assert.equal(row.querySelector(".kb-reset").hidden, true, "registration default counts as default (no reset)");
  // Backspace-unbind actually disables dispatch
  row.querySelector(".kb-chord").click();
  doc.dispatchEvent(key(doc, "Backspace"));
  assert.equal(getBinding("hier.fit"), null);
  assert.equal(rowFor("Fit to screen").querySelector(".kb-chord").textContent, "unbound");
  const fakeEvent = { key: "f", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {} };
  assert.equal(matchEvent(fakeEvent, { isMac: true, insideTerminal: false, editableTarget: false }), null,
    "unbound registration default no longer dispatches");
  // per-row reset restores the registration default
  rowFor("Fit to screen").querySelector(".kb-reset").click();
  assert.equal(getBinding("hier.fit"), "F");
  editor.close();
});

test("rerender keeps keyboard focus inside the modal (record/unbind/reset)", (t) => {
  const { doc, editor } = setup(t);
  setBinding("app.palette", "Mod+P"); // ensure the palette row has a visible reset
  editor.open();
  const dialog = doc.querySelector('[role="dialog"]');
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);

  // record from a focused chord button: focus returns to the SAME row's button
  const chordBtn = rowFor("Command palette").querySelector(".kb-chord");
  chordBtn.focus();
  chordBtn.click();
  doc.dispatchEvent(key(doc, "j", { metaKey: true }));
  assert.ok(dialog.contains(doc.activeElement), "focus stays in the dialog after recording");
  assert.equal(doc.activeElement.dataset.actionId, "app.palette");
  assert.ok(doc.activeElement.classList.contains("kb-chord"));

  // Backspace-unbind: same containment
  doc.activeElement.click();
  doc.dispatchEvent(key(doc, "Backspace"));
  assert.ok(dialog.contains(doc.activeElement), "focus stays after unbind");
  assert.equal(doc.activeElement.dataset.actionId, "app.palette");

  // per-row reset: the reset button disappears (row back at default) — focus
  // falls back to the row's chord button, still inside the dialog
  const resetBtn = rowFor("Command palette").querySelector(".kb-reset");
  assert.equal(resetBtn.hidden, false);
  resetBtn.focus();
  resetBtn.click();
  assert.ok(dialog.contains(doc.activeElement), "focus stays after per-row reset");
  assert.equal(doc.activeElement.dataset.actionId, "app.palette");
  assert.ok(doc.activeElement.classList.contains("kb-chord"), "hidden reset falls back to chord button");

  // and the NEXT Tab cannot escape: it wraps within the dialog
  const overlay = doc.querySelector(".kb-overlay");
  const tab = key(doc, "Tab");
  overlay.dispatchEvent(tab);
  assert.ok(dialog.contains(doc.activeElement), "Tab after rerender remains trapped");

  // reset-all from its own (non-row) button keeps focus in the dialog too
  setBinding("tabs.close", "Mod+X");
  const resetAll = doc.querySelector(".kb-reset-all");
  resetAll.focus();
  resetAll.click();
  assert.ok(dialog.contains(doc.activeElement), "focus stays after reset-all");
  editor.close();
});

test("Escape (outside recording) and overlay backdrop close the dialog; toggle works", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  assert.equal(editor.isOpen(), true);
  doc.querySelector(".kb-overlay").dispatchEvent(key(doc, "Escape"));
  assert.equal(editor.isOpen(), false);
  editor.toggle();
  assert.equal(editor.isOpen(), true);
  editor.toggle();
  assert.equal(editor.isOpen(), false);
});

test("recording does not survive dialog close or reset-all", (t) => {
  const { doc, editor } = setup(t);
  editor.open();
  const rowFor = (label) => [...doc.querySelectorAll(".kb-row")]
    .find((r) => r.querySelector(".kb-label").textContent === label);

  // close during recording: the capture listener must be torn down
  rowFor("Command palette").querySelector(".kb-chord").click();
  editor.close();
  const e = key(doc, "x", { metaKey: true });
  doc.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false, "closed editor must not swallow keys");
  assert.equal(getBinding("app.palette"), DEFAULT_KEYMAP["app.palette"],
    "closed editor must not persist a binding");

  // reset-all during recording: capture ends, nothing recorded afterwards
  editor.open();
  rowFor("Command palette").querySelector(".kb-chord").click();
  doc.querySelector(".kb-reset-all").click();
  doc.dispatchEvent(key(doc, "y", { metaKey: true }));
  assert.equal(getBinding("app.palette"), DEFAULT_KEYMAP["app.palette"]);

  // rerender (keymap change from elsewhere) also invalidates a capture
  rowFor("Command palette").querySelector(".kb-chord").click();
  setBinding("tabs.close", "Mod+X"); // triggers render
  doc.dispatchEvent(key(doc, "z", { metaKey: true }));
  assert.equal(getBinding("app.palette"), DEFAULT_KEYMAP["app.palette"]);
  editor.close();
});

test("malformed persisted overrides are sanitized and cannot break the editor", async (t) => {
  // corrupt payload BEFORE the module (re)reads storage
  localStorage.setItem("oas-desktop-keymap",
    JSON.stringify({ "app.palette": 42, "tabs.close": { evil: true }, "stage.hierarchy.focus": "Mod+K+P", "x.legacy": "Mod+Shift+L", "x.unbound": null }));
  const fresh = await import("../renderer/keybindings.mjs?fresh=" + Math.random());
  assert.equal(fresh.getBinding("app.palette"), "Mod+K", "non-string value discarded → default");
  assert.equal(fresh.getBinding("tabs.close"), "Mod+W", "object value discarded → default");
  assert.equal(fresh.getBinding("stage.hierarchy.focus"), null,
    "unparsable chord string (two main keys) discarded → no default → unbound");
  assert.equal(fresh.getBinding("x.legacy"), "Mod+Shift+L", "valid chord survives");
  assert.equal(fresh.getBinding("x.unbound"), null, "explicit null unbind survives");
  localStorage.removeItem("oas-desktop-keymap");

  // and the editor renders instead of throwing on a poisoned live map too
  const { doc, editor } = setup(t);
  assert.doesNotThrow(() => { editor.open(); editor.close(); });
});

test("Tab wraps focus inside the modal dialog", (t) => {
  const { doc, editor } = setup(t);
  const outside = doc.createElement("button");
  outside.textContent = "outside";
  doc.body.append(outside);
  editor.open();
  const overlay = doc.querySelector(".kb-overlay");
  const dialog = overlay.querySelector(".kb-editor");
  const focusable = [...dialog.querySelectorAll("button:not([disabled])")]
    .filter((el) => !el.hidden && el.tabIndex >= 0);
  const first = focusable[0], last = focusable.at(-1);

  last.focus();
  const tab = key(doc, "Tab");
  overlay.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true, "Tab on the last control is wrapped");
  assert.equal(doc.activeElement, first);

  first.focus();
  const shiftTab = key(doc, "Tab", { shiftKey: true });
  overlay.dispatchEvent(shiftTab);
  assert.equal(shiftTab.defaultPrevented, true, "Shift+Tab on the first control is wrapped");
  assert.equal(doc.activeElement, last);
  editor.close();
});
