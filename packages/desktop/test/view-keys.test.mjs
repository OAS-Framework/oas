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
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("f"), actions, { isMac: false, binding }), "hier.fit");
  assert.equal(resolveViewKey(ev("x"), actions, { isMac: false, binding }), null);
});

test("a rebound action answers its new chord and its old default stops firing", () => {
  const binding = (id) => (id === "hier.brain" ? "X" : null);
  assert.equal(resolveViewKey(ev("x"), actions, { isMac: false, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), null,
    "old default must not fire after rebinding");
});

test("an explicit binding on a key beats another action's default on the same key", () => {
  const binding = (id) => (id === "hier.fit" ? "B" : null);
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), "hier.fit",
    "bound chord wins over an unbound action's default");
});

test("modifier chords from the engine match platform Mod folding", () => {
  const binding = (id) => (id === "hier.brain" ? "Mod+B" : null);
  assert.equal(resolveViewKey(ev("b", { ctrlKey: true }), actions, { isMac: false, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("b", { metaKey: true }), actions, { isMac: true, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), null);
});
