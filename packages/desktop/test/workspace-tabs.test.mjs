import test from "node:test";
import assert from "node:assert/strict";
import {
  terminalTabsForWorkspace, tabVisibleInContext, canActivateTab,
  fallbackTabForContext, terminalOpenOwnsWorkspace,
} from "../renderer/workspace-tabs.mjs";

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

test("shell fallback: closing B terminal never activates hidden A terminal", () => {
  const tabsAfterClose = new Map([
    [1, { kind: "terminal", workspace: "wsA", key: "term:wsA:dev-1" }],
    [3, { kind: "brain", workspace: null, key: "view:brain" }],
  ]);
  assert.equal(canActivateTab(tabsAfterClose.get(1), "wsB"), false,
    "activation boundary rejects hidden workspace-A pane");
  assert.equal(fallbackTabForContext(tabsAfterClose, "instances", "wsB"), null,
    "Instances/B has no fallback after its last terminal closes");
});

test("shell deferred open: A completion loses ownership after switch to B", () => {
  assert.equal(terminalOpenOwnsWorkspace("wsA", "wsA"), true);
  assert.equal(terminalOpenOwnsWorkspace("wsA", "wsB"), false,
    "late A /api/panel completion must be discarded before addTab auto-activation");
});
