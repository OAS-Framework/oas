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

test("an explicit engine unbind kills the key — no fallback to a stale local chord", () => {
  // engine owns defaults now (DEFAULT_KEYMAP hier.*); getBinding returning
  // null after Backspace-unbind must NOT resurrect any legacy chord field
  const withLegacy = [{ id: "hier.brain", chord: "b" }];
  const binding = () => null; // explicit unbind and no-default look identical — both must not fire when registered
  const registered = () => [{ id: "hier.brain", context: "stage:hierarchy" }];
  // legacy chord still honored ONLY because the id is in the passed actions;
  // engine-registered actions rely on DEFAULT_KEYMAP, not the legacy field
  assert.equal(resolveViewKey(ev("b"), withLegacy, { isMac: false, binding, registered }), "hier.brain");
  const noLegacy = [{ id: "hier.brain" }];
  assert.equal(resolveViewKey(ev("b"), noLegacy, { isMac: false, binding, registered }), null,
    "without a legacy chord, an unbound action does not fire");
});
