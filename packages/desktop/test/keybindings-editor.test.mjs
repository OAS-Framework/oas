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
  assert.equal(rows.length, 3);
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
