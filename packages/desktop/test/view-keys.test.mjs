// view-local key dispatch — engine-owned effective bindings only.
// (review 4f57091: the legacy chord-fallback path was removed; the resolver
// answers exclusively from getBinding — override ?? default ?? registration
// defaultChord — so an explicit editor unbind is dead here too.)
import test from "node:test";
import assert from "node:assert/strict";
import { resolveViewKey } from "../renderer/view-keys.mjs";

const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const actions = [
  { id: "hier.brain" },
  { id: "hier.fit" },
];

test("effective bindings from the engine drive dispatch (registration defaults included)", () => {
  // engine reports the effective chord (e.g. registration defaultChord "B"/"F")
  const binding = (id) => (id === "hier.brain" ? "B" : id === "hier.fit" ? "F" : null);
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("f"), actions, { isMac: false, binding }), "hier.fit");
  assert.equal(resolveViewKey(ev("x"), actions, { isMac: false, binding }), null);
});

test("a rebound action answers its new chord and its old default stops firing", () => {
  // user rebound hier.brain to X: getBinding returns the override
  const binding = (id) => (id === "hier.brain" ? "X" : null);
  assert.equal(resolveViewKey(ev("x"), actions, { isMac: false, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), null,
    "old default must not fire after rebinding — no resolver-side memory of it");
});

test("an explicit unbind (null effective binding) makes the key dead — nothing resurrects it", () => {
  // Backspace in the editor persists null; getBinding returns null
  const binding = () => null;
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), null);
  assert.equal(resolveViewKey(ev("f"), actions, { isMac: false, binding }), null);
});

test("modifier chords from the engine match platform Mod folding", () => {
  const binding = (id) => (id === "hier.brain" ? "Mod+B" : null);
  assert.equal(resolveViewKey(ev("b", { ctrlKey: true }), actions, { isMac: false, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("b", { metaKey: true }), actions, { isMac: true, binding }), "hier.brain");
  assert.equal(resolveViewKey(ev("b"), actions, { isMac: false, binding }), null,
    "bare key does not satisfy a modifier chord");
});

test("pure-modifier keydowns resolve to nothing", () => {
  const binding = () => "B";
  assert.equal(resolveViewKey(ev("Shift", { shiftKey: true }), actions, { isMac: false, binding }), null);
  assert.equal(resolveViewKey(ev("Control", { ctrlKey: true }), actions, { isMac: false, binding }), null);
});
