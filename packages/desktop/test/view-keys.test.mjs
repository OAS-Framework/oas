// view-local key dispatch resolved through the engine keymap.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveViewKey } from "../renderer/view-keys.mjs";

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
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered, context: "stage:hierarchy" }), null,
    "view default must not intercept a chord explicitly bound elsewhere");
  // but an unrelated explicit binding does not disable other defaults
  assert.equal(resolveViewKey(ev("f"), actions, { isMac: false, binding, registered, context: "stage:hierarchy" }), "hier.fit");
});

test("an inactive-context binding does not suppress a view default (review 4a3438e)", () => {
  // tabs.next rebound to "b": it can never fire on the hierarchy canvas
  // (context-ineligible in the engine), so suppressing hier.brain would
  // make the key entirely dead. Same-context and global bindings still win.
  // (legacy-chord path: the view actions are engine-UNKNOWN here)
  const binding = (id) => (id === "tabs.next" ? "B" : null);
  const registered = () => [{ id: "tabs.next", context: "tabs" }];
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered, context: "stage:hierarchy" }), "hier.brain",
    "foreign inactive context must not turn the view key dead");
  // same-context explicit binding still suppresses the default
  const sameCtx = (id) => (id === "hier.other" ? "B" : null);
  const registered2 = () => [{ id: "hier.other", context: "stage:hierarchy" }];
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding: sameCtx, registered: registered2, context: "stage:hierarchy" }), null,
    "same-context explicit binding still wins over the default");
  // without a context hint, behave conservatively (any explicit binding wins)
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered }), null,
    "no context hint keeps the conservative rule");
});

test("modifier chords from the engine match platform Mod folding", () => {
  const binding = (id) => (id === "hier.brain" ? "Mod+B" : null);
  const registered = () => [];
  assert.equal(resolveViewKey(ev("b", { ctrlKey: true }), actions, { isMac: false, binding, registered }), "hier.brain");
  assert.equal(resolveViewKey(ev("b", { metaKey: true }), actions, { isMac: true, binding, registered }), "hier.brain");
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding, registered }), null);
});

test("an explicit engine unbind kills the key — legacy chords never resurrect registered actions (review 0e63834 nit)", () => {
  const withLegacy = [{ id: "hier.brain", chord: "b" }];
  const binding = () => null; // registered + null binding = unbound by choice
  const registered = () => [{ id: "hier.brain", context: "stage:hierarchy" }];
  assert.equal(resolveViewKey(ev("b"), withLegacy, { isMac: false, binding, registered }), null,
    "a REGISTERED action with a null effective binding is dead — the legacy chord must not fire");
  // engine-unknown action (not registered): the legacy chord is the only
  // source of truth and still works (test seam / gradual migration)
  assert.equal(resolveViewKey(ev("b"), withLegacy, { isMac: false, binding, registered: () => [] }), "hier.brain",
    "engine-unknown actions keep their legacy chord");
});
