// sidebar roster tree keyboard policy — pure, per house style.
import test from "node:test";
import assert from "node:assert/strict";
import { rosterKeyAction, moveTarget, rovingIndex } from "../renderer/roster-keys.mjs";

test("arrows walk rows; Right expands a collapsed branch, else moves down", () => {
  assert.deepEqual(rosterKeyAction({ key: "ArrowDown" }), { type: "move", delta: 1 });
  assert.deepEqual(rosterKeyAction({ key: "ArrowUp" }), { type: "move", delta: -1 });
  assert.deepEqual(rosterKeyAction({ key: "ArrowRight" }, { hasChildren: true, collapsed: true }), { type: "expand" });
  assert.deepEqual(rosterKeyAction({ key: "ArrowRight" }, { hasChildren: true, collapsed: false }), { type: "move", delta: 1 });
  assert.deepEqual(rosterKeyAction({ key: "ArrowRight" }, { hasChildren: false }), { type: "move", delta: 1 });
});

test("Left collapses an open branch, else jumps to the parent row", () => {
  assert.deepEqual(rosterKeyAction({ key: "ArrowLeft" }, { hasChildren: true, collapsed: false }), { type: "collapse" });
  assert.deepEqual(rosterKeyAction({ key: "ArrowLeft" }, { hasChildren: true, collapsed: true }), { type: "parent" });
  assert.deepEqual(rosterKeyAction({ key: "ArrowLeft" }, { hasChildren: false }), { type: "parent" });
});

test("Home/End jump; unowned keys return null (Enter stays native)", () => {
  assert.deepEqual(rosterKeyAction({ key: "Home" }), { type: "move", to: "first" });
  assert.deepEqual(rosterKeyAction({ key: "End" }), { type: "move", to: "last" });
  assert.equal(rosterKeyAction({ key: "Enter" }), null);
  assert.equal(rosterKeyAction({ key: "a" }), null);
});

test("moveTarget clamps at the edges (no wrap) and handles empty lists", () => {
  assert.equal(moveTarget({ delta: 1 }, 2, 3), 2, "clamped at last");
  assert.equal(moveTarget({ delta: -1 }, 0, 3), 0, "clamped at first");
  assert.equal(moveTarget({ delta: 1 }, 0, 3), 1);
  assert.equal(moveTarget({ to: "first" }, 2, 3), 0);
  assert.equal(moveTarget({ to: "last" }, 0, 3), 2);
  assert.equal(moveTarget({ delta: 1 }, 0, 0), -1);
});

test("rovingIndex keeps exactly one tabbable row", () => {
  assert.equal(rovingIndex(3, 1), 1);
  assert.equal(rovingIndex(3, -1), 0, "no focus -> first row tabbable");
  assert.equal(rovingIndex(3, 7), 0, "stale focus index falls back to first");
  assert.equal(rovingIndex(0, 0), -1);
});
