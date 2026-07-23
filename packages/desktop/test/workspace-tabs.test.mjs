import test from "node:test";
import assert from "node:assert/strict";
import { terminalTabsForWorkspace, tabVisibleInContext } from "../renderer/workspace-tabs.mjs";

test("terminal tabs: same-named A/B instances remain workspace-scoped", () => {
  const tabs = new Map([
    [1, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-1" }],
    [2, { kind: "terminal", workspace: "wsB", key: "term:wsB:dev-1" }],
    [3, { kind: "brain", workspace: null, key: "view:brain" }],
  ]);
  assert.deepEqual(terminalTabsForWorkspace(tabs, "wsA").map(([id]) => id), [1]);
  assert.deepEqual(terminalTabsForWorkspace(tabs, "wsB").map(([id]) => id), [2]);
  assert.equal(tabVisibleInContext(tabs.get(1), "instances", "wsB"), false,
    "workspace A terminal must be hidden beside workspace B roster");
  assert.equal(tabVisibleInContext(tabs.get(2), "instances", "wsB"), true);
  assert.equal(tabVisibleInContext(tabs.get(3), "instances", "wsB"), false);
  assert.equal(tabVisibleInContext(tabs.get(3), "souls", "wsB"), true);
});
