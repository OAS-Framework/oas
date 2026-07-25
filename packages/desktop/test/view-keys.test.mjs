// view-local key dispatch resolved through the engine keymap.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveViewKey, isEditableTarget, allowsEngineDispatch } from "../renderer/view-keys.mjs";

const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const actions = [
  { id: "hier.brain", chord: "b" },
  { id: "hier.fit", chord: "f" },
];

test("default chords fire while the engine reports the action unbound", () => {
  const binding = () => null;
  const registered = () => [];
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered }), "hier.brain");
  assert.equal(resolveViewKey(ev("f"), actions, { isMac: false, binding, registered }), "hier.fit");
  assert.equal(resolveViewKey(ev("x"), actions, { isMac: false, binding, registered }), null);
});

test("a rebound action answers its new chord and its old default stops firing", () => {
  const binding = (id) => (id === "hier.brain" ? "X" : null);
  const registered = () => [];
  assert.equal(resolveViewKey(ev("x"), actions, { isMac: false, binding, registered }), "hier.brain");
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered }), null,
    "old default must not fire after rebinding");
});

test("an explicit binding on a key beats another action's default on the same key", () => {
  const binding = (id) => (id === "hier.fit" ? "B" : null);
  const registered = () => [];
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered }), "hier.fit",
    "bound chord wins over an unbound action's default");
});

test("a local default yields to an explicit binding on a NON-view action (review 93ff03d)", () => {
  // the user deliberately bound "b" to a global action; the hierarchy's
  // local default for hier.brain must not shadow it
  const binding = (id) => (id === "app.doThing" ? "B" : null);
  const registered = () => [{ id: "app.doThing", context: "global" }, { id: "hier.brain", context: "stage:hierarchy" }];
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered }), null,
    "view default must not intercept a chord explicitly bound elsewhere");
  // but an unrelated explicit binding does not disable other defaults
  assert.equal(resolveViewKey(ev("f"), actions, { isMac: false, binding, registered }), "hier.fit");
});

test("modifier chords from the engine match platform Mod folding", () => {
  const binding = (id) => (id === "hier.brain" ? "Mod+B" : null);
  const registered = () => [];
  assert.equal(resolveViewKey(ev("b", { ctrlKey: true }), actions, { isMac: false, binding, registered }), "hier.brain");
  assert.equal(resolveViewKey(ev("b", { metaKey: true }), actions, { isMac: true, binding, registered }), "hier.brain");
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered }), null);
});

test("isEditableTarget covers input/textarea/select/contenteditable", () => {
  assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableTarget({ tagName: "SELECT" }), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: "DIV" }), false);
  assert.equal(isEditableTarget(null), false);
});

test("engine dispatch guard: unmodified keys never fire from editable targets (review c2a09e8)", () => {
  const input = { tagName: "TEXTAREA" };
  const div = { tagName: "DIV" };
  // a user-recorded bare-key binding must not steal typed characters
  assert.equal(allowsEngineDispatch({ ...ev("a"), target: input }, { isMac: false }), false);
  assert.equal(allowsEngineDispatch({ ...ev("a", { shiftKey: true }), target: input }, { isMac: false }), false,
    "shift-only still produces text");
  // modifier shortcuts stay live while typing
  assert.equal(allowsEngineDispatch({ ...ev("k", { ctrlKey: true }), target: input }, { isMac: false }), true);
  assert.equal(allowsEngineDispatch({ ...ev("k", { metaKey: true }), target: input }, { isMac: true }), true);
  assert.equal(allowsEngineDispatch({ ...ev("b", { altKey: true }), target: input }, { isMac: false }), true);
  // non-editable targets always dispatch
  assert.equal(allowsEngineDispatch({ ...ev("a"), target: div }, { isMac: false }), true);
  assert.equal(allowsEngineDispatch({ ...ev("a"), target: null }, { isMac: false }), true);
});
