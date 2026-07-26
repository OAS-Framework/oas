// split-layout.mjs — pure split-pane state transitions.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SPLIT_PANES, requestSplit, absorbTab, removeSplitTab, isSplitMember,
  adjacentSplitMember,
} from "../renderer/split-layout.mjs";

test("requestSplit starts a split from the active terminal with one pending slot", () => {
  const { split, changed } = requestSplit(null, "row", 7);
  assert.ok(changed);
  assert.deepEqual(split, { orientation: "row", members: [7], pending: 1 });
});

test("requestSplit without an active terminal is a no-op", () => {
  assert.deepEqual(requestSplit(null, "row", null), { split: null, changed: false });
  assert.deepEqual(requestSplit(null, "col", undefined), { split: null, changed: false });
});

test("requestSplit on an existing split adds ONE pending slot and re-orients", () => {
  const s0 = { orientation: "row", members: [1, 2], pending: 0 };
  const { split, changed } = requestSplit(s0, "col", 1);
  assert.ok(changed);
  assert.deepEqual(split, { orientation: "col", members: [1, 2], pending: 1 });
  assert.deepEqual(s0, { orientation: "row", members: [1, 2], pending: 0 }, "input not mutated");
});

test("a second split request while a slot is still empty does not stack pending slots", () => {
  // the renderer owns a single empty-slot placeholder — the model must
  // never record more empty slots than the DOM can show (review 156cbc7)
  const s = { orientation: "row", members: [1], pending: 1 };
  const same = requestSplit(s, "row", 1);
  assert.equal(same.changed, false);
  assert.equal(same.split, s);
  // a different orientation still re-orients, without adding a slot
  const flipped = requestSplit(s, "col", 1);
  assert.ok(flipped.changed);
  assert.deepEqual(flipped.split, { orientation: "col", members: [1], pending: 1 });
});

test("requestSplit is capped at MAX_SPLIT_PANES (members + pending)", () => {
  let s = { orientation: "row", members: [1, 2, 3, 4], pending: 0 };
  assert.equal(s.members.length + s.pending, MAX_SPLIT_PANES);
  const same = requestSplit(s, "row", 1);
  assert.equal(same.changed, false);
  assert.equal(same.split, s);
  // at the cap a different orientation still re-orients (no new slot)
  const flipped = requestSplit(s, "col", 1);
  assert.ok(flipped.changed);
  assert.equal(flipped.split.orientation, "col");
  assert.equal(flipped.split.members.length + flipped.split.pending, MAX_SPLIT_PANES);
});

test("absorbTab fills the pending slot with a NEW tab only", () => {
  const s = { orientation: "row", members: [1], pending: 1 };
  const r = absorbTab(s, 2);
  assert.ok(r.absorbed);
  assert.deepEqual(r.split, { orientation: "row", members: [1, 2], pending: 0 });
  // an existing member is never absorbed twice
  const again = absorbTab(r.split, 2);
  assert.equal(again.absorbed, false);
  // no pending slot: nothing absorbed
  assert.equal(absorbTab(r.split, 3).absorbed, false);
  // no split at all
  assert.deepEqual(absorbTab(null, 3), { split: null, absorbed: false });
});

test("removeSplitTab collapses to single-pane when fewer than two panes remain", () => {
  const s = { orientation: "row", members: [1, 2], pending: 0 };
  assert.equal(removeSplitTab(s, 1), null, "one member left → single pane");
  const s3 = { orientation: "col", members: [1, 2, 3], pending: 0 };
  assert.deepEqual(removeSplitTab(s3, 2), { orientation: "col", members: [1, 3], pending: 0 });
  // a lone member with only a pending slot remaining collapses too
  const sp = { orientation: "row", members: [1], pending: 1 };
  assert.equal(removeSplitTab(sp, 1), null);
  // non-members leave the split untouched
  assert.equal(removeSplitTab(s3, 99), s3);
  assert.equal(removeSplitTab(null, 1), null);
});

test("adjacentSplitMember prefers the next member, then the previous, else null", () => {
  const s = { orientation: "row", members: [1, 2, 3], pending: 0 };
  assert.equal(adjacentSplitMember(s, 1), 2, "right/lower neighbor wins");
  assert.equal(adjacentSplitMember(s, 2), 3);
  assert.equal(adjacentSplitMember(s, 3), 2, "last member falls back left/up");
  assert.equal(adjacentSplitMember(s, 99), null, "non-member");
  assert.equal(adjacentSplitMember({ orientation: "row", members: [1], pending: 1 }, 1), null,
    "no other member survives");
  assert.equal(adjacentSplitMember(null, 1), null);
});

test("isSplitMember", () => {
  assert.equal(isSplitMember(null, 1), false);
  assert.equal(isSplitMember({ orientation: "row", members: [1, 2], pending: 0 }, 2), true);
  assert.equal(isSplitMember({ orientation: "row", members: [1, 2], pending: 0 }, 3), false);
});
