// Pure editor-group split model — VS Code semantics (persistent groups,
// each owning an ordered tab list + active tab; new tabs open into the
// focused group; the layout survives tab switches).
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SPLIT_GROUPS, requestSplit, focusTab, openTabInFocusedGroup,
  isSplitMember, groupOfTab, removeSplitTab,
} from "../renderer/split-layout.mjs";

test("first split seeds ALL current tabs into group 1 and focuses the new empty group", () => {
  const { split, changed } = requestSplit(null, "row", [1, 2, 3], 2);
  assert.ok(changed);
  assert.equal(split.orientation, "row");
  assert.equal(split.groups.length, 2);
  // human requirement: all tabs that were in the strip stay together
  assert.deepEqual(split.groups[0].tabs, [1, 2, 3]);
  assert.equal(split.groups[0].activeTab, 2, "current tab stays active in group 1");
  assert.deepEqual(split.groups[1].tabs, [], "new group starts empty");
  // VS Code: the newly created group becomes the focused one
  assert.equal(split.focusedGroup, split.groups[1].id);
});

test("split refuses without an active member tab", () => {
  assert.equal(requestSplit(null, "row", [1, 2], null).changed, false);
  assert.equal(requestSplit(null, "row", [1, 2], 9).changed, false, "active id must be in the layer");
});

test("splitting again while an empty group exists only re-orients", () => {
  const { split } = requestSplit(null, "row", [1], 1);
  const again = requestSplit(split, "row", null, null);
  assert.equal(again.changed, false, "same orientation: no change");
  const reoriented = requestSplit(split, "col", null, null);
  assert.ok(reoriented.changed);
  assert.equal(reoriented.split.orientation, "col");
  assert.equal(reoriented.split.groups.length, 2, "no group accrual behind one placeholder");
});

test("new terminal tab opens into the FOCUSED group and becomes its active tab", () => {
  let { split } = requestSplit(null, "row", [1], 1);
  ({ split } = openTabInFocusedGroup(split, 5));
  assert.deepEqual(split.groups[1].tabs, [5]);
  assert.equal(split.groups[1].activeTab, 5);
  assert.equal(split.focusedGroup, split.groups[1].id);
  // focus back on group 1, open another: it must land in group 1
  ({ split } = focusTab(split, 1));
  ({ split } = openTabInFocusedGroup(split, 7));
  assert.deepEqual(split.groups[0].tabs, [1, 7]);
  assert.equal(split.groups[0].activeTab, 7);
  // an existing member is focused, never duplicated
  const r = openTabInFocusedGroup(split, 5);
  assert.deepEqual(r.split.groups[1].tabs, [5]);
  assert.equal(r.split.focusedGroup, r.split.groups[1].id, "focus follows the member's group");
});

test("focusTab moves the group's activeTab and group focus; switching tabs never dismantles the split", () => {
  let { split } = requestSplit(null, "row", [1, 2], 1);
  ({ split } = openTabInFocusedGroup(split, 5));
  const r = focusTab(split, 2);
  assert.ok(r.changed);
  assert.equal(r.split.groups.length, 2, "split persists across tab switch");
  assert.equal(r.split.groups[0].activeTab, 2);
  assert.equal(r.split.focusedGroup, r.split.groups[0].id);
  assert.equal(focusTab(r.split, 2).changed, false, "idempotent");
  assert.equal(focusTab(r.split, 99).changed, false, "non-member no-op");
});

test("subsequent split inserts the new focused group after the focused one, up to the cap", () => {
  let { split } = requestSplit(null, "row", [1], 1);
  ({ split } = openTabInFocusedGroup(split, 2));
  ({ split } = focusTab(split, 1)); // focus first group
  const r = requestSplit(split, "row", null, null);
  assert.ok(r.changed);
  assert.equal(r.split.groups.length, 3);
  assert.deepEqual(r.split.groups.map((g) => g.tabs.length), [1, 0, 1], "new group after the focused one");
  assert.equal(r.split.focusedGroup, r.split.groups[1].id);
  // fill it, then split to the cap; beyond the cap only re-orientation changes
  ({ split } = openTabInFocusedGroup(r.split, 3));
  ({ split } = requestSplit(split, "row", null, null));
  ({ split } = openTabInFocusedGroup(split, 4));
  assert.equal(split.groups.length, MAX_SPLIT_GROUPS);
  assert.equal(requestSplit(split, "row", null, null).changed, false);
  const reor = requestSplit(split, "col", null, null);
  assert.ok(reor.changed);
  assert.equal(reor.split.groups.length, MAX_SPLIT_GROUPS);
});

test("group ids are stable and unique across insertions", () => {
  let { split } = requestSplit(null, "row", [1], 1);
  ({ split } = openTabInFocusedGroup(split, 2));
  ({ split } = requestSplit(split, "row", null, null));
  const ids = split.groups.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("membership helpers", () => {
  const { split } = requestSplit(null, "row", [1, 2], 1);
  assert.ok(isSplitMember(split, 2));
  assert.ok(!isSplitMember(split, 9));
  assert.ok(!isSplitMember(null, 1));
  assert.equal(groupOfTab(split, 1), split.groups[0]);
});

test("closing a non-active member keeps the group's active tab; no successor", () => {
  let { split } = requestSplit(null, "row", [1, 2, 3], 2);
  ({ split } = openTabInFocusedGroup(split, 5));
  const r = removeSplitTab(split, 3);
  assert.equal(r.successor, null);
  assert.deepEqual(r.split.groups[0].tabs, [1, 2]);
  assert.equal(r.split.groups[0].activeTab, 2);
});

test("closing the group-active tab picks the right-then-left neighbor IN THE GROUP", () => {
  let { split } = requestSplit(null, "row", [1, 2, 3], 2);
  ({ split } = openTabInFocusedGroup(split, 5));
  const r = removeSplitTab(split, 2);
  assert.equal(r.successor, 3, "right neighbor in the same group, not the newest tab (5)");
  assert.equal(r.split.groups[0].activeTab, 3);
  const r2 = removeSplitTab(r.split, 3);
  assert.equal(r2.successor, 1, "left neighbor when no right one");
});

test("closing a group's last tab collapses the group; successor is the neighbor group's active tab", () => {
  let { split } = requestSplit(null, "row", [1, 2], 1);
  ({ split } = openTabInFocusedGroup(split, 5));
  ({ split } = requestSplit(split, "row", null, null));
  ({ split } = openTabInFocusedGroup(split, 6)); // groups: [1,2] [5] [6]
  const r = removeSplitTab(split, 5);
  assert.equal(r.split.groups.length, 2, "middle group collapsed");
  assert.equal(r.successor, 6, "neighbor group's active tab survives as successor");
});

test("down to one group the model collapses to null (flat strip)", () => {
  let { split } = requestSplit(null, "row", [1, 2], 1);
  ({ split } = openTabInFocusedGroup(split, 5));
  const r = removeSplitTab(split, 5);
  assert.equal(r.split, null);
  assert.equal(r.successor, 1, "the surviving group's active tab");
});

test("removing the last tab of the ONLY populated pair collapses cleanly (empty group present)", () => {
  const { split } = requestSplit(null, "row", [1], 1); // [1] + empty focused group
  const r = removeSplitTab(split, 1);
  assert.equal(r.split, null, "an empty group cannot stand alone");
});

test("collapsing the focused group moves focus to the successor's group", () => {
  let { split } = requestSplit(null, "row", [1, 2], 1);
  ({ split } = openTabInFocusedGroup(split, 5));
  ({ split } = requestSplit(split, "row", null, null));
  ({ split } = openTabInFocusedGroup(split, 6)); // groups: [1,2] [5]* [6]
  ({ split } = focusTab(split, 5));
  const r = removeSplitTab(split, 5);
  assert.equal(groupOfTab(r.split, r.successor).id, r.split.focusedGroup,
    "focusedGroup never dangles on a removed group id");
});

test("mutation guard: removeSplitTab of a non-member changes nothing", () => {
  const { split } = requestSplit(null, "row", [1, 2], 1);
  const r = removeSplitTab(split, 42);
  assert.equal(r.split, split);
  assert.equal(r.successor, null);
  assert.deepEqual(removeSplitTab(null, 1), { split: null, successor: null });
});
