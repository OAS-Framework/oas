import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  collapseKey, hasInstanceChildren, treeGuideSegments, filterInstanceTree, instanceVisibleInTree,
  captureTreeRenderState, configureDisclosure, rosterResponseOwns,
} from "../renderer/instance-tree.mjs";

const instances = [
  { instance: "root" },
  { instance: "child", parentInstance: "root" },
  { instance: "grand", parentInstance: "child" },
  { instance: "sibling", parentInstance: "root" },
  { instance: "other" },
];

test("instance tree collapse hides arbitrary-depth descendants but not peers", () => {
  const collapsed = new Set([collapseKey("wsA", "child")]);
  const visible = (name, ws = "wsA", filtering = false) => instanceVisibleInTree(
    instances.find((i) => i.instance === name), instances, collapsed, ws, filtering,
  );
  assert.equal(visible("root"), true);
  assert.equal(visible("child"), true, "collapsed parent itself stays visible");
  assert.equal(visible("grand"), false);
  assert.equal(visible("sibling"), true);
  assert.equal(visible("other"), true);
  assert.equal(visible("grand", "wsB"), true, "collapse state is workspace-scoped");
  assert.equal(visible("grand", "wsA", true), true, "filtering reveals matching descendants without changing state");
});

test("tree guides terminate final siblings and continue only real ancestor branches", () => {
  const flat = [
    { instance: "root", depth: 0 },
    { instance: "child-a", parentInstance: "root", depth: 1 },
    { instance: "grand", parentInstance: "child-a", depth: 2 },
    { instance: "child-b", parentInstance: "root", depth: 1 },
  ];
  assert.deepEqual(treeGuideSegments(flat, flat[1]), ["branch"], "non-final child continues below its elbow");
  assert.deepEqual(treeGuideSegments(flat, flat[2]), ["continue", "end"],
    "grandchild keeps a real ancestor continuation and ends its own branch");
  assert.deepEqual(treeGuideSegments(flat, flat[3]), ["end"], "last child line stops at its elbow");

  const onlyBranch = flat.slice(0, 3);
  assert.deepEqual(treeGuideSegments(onlyBranch, onlyBranch[2]), ["none", "end"],
    "descendants do not extend an exhausted parent sibling line");
});

test("instance tree detects disclosure parents and survives malformed cycles", () => {
  assert.equal(hasInstanceChildren(instances, "root"), true);
  assert.equal(hasInstanceChildren(instances, "grand"), false);
  const cyclic = [
    { instance: "a", parentInstance: "b" },
    { instance: "b", parentInstance: "a" },
  ];
  assert.equal(instanceVisibleInTree(cyclic[0], cyclic, new Set(), "ws"), true);
  assert.equal(instanceVisibleInTree(cyclic[0], cyclic, new Set([collapseKey("ws", "b")]), "ws"), false);
});

test("DOM rerender preserves focused disclosure/terminal identity and scroll across toggle and poll", () => {
  const dom = new JSDOM(`<!doctype html><body><div id="list"></div></body>`);
  const list = dom.window.document.getElementById("list");
  Object.defineProperty(list, "scrollTop", { value: 73, writable: true });
  const paint = (control = "disclosure") => {
    list.innerHTML = `<button data-tree-instance="root" data-tree-control="${control}">${control}</button>`;
  };
  paint();
  list.querySelector("button").focus();
  let restore = captureTreeRenderState(list);
  paint(); // disclosure toggle rebuild
  list.scrollTop = 0;
  assert.equal(restore(), true);
  assert.equal(dom.window.document.activeElement.dataset.treeControl, "disclosure");
  assert.equal(list.scrollTop, 73);

  restore = captureTreeRenderState(list);
  paint(); // polling refresh/reorder rebuild
  const replacement = list.querySelector("button");
  const nativeFocus = replacement.focus.bind(replacement);
  let focusOptions;
  replacement.focus = (options) => {
    focusOptions = options;
    nativeFocus(options);
    list.scrollTop = 0; // simulate Chromium scrolling the focused/reordered row
  };
  list.scrollTop = 5;
  assert.equal(restore(), true);
  assert.deepEqual(focusOptions, { preventScroll: true });
  assert.equal(dom.window.document.activeElement.dataset.treeInstance, "root");
  assert.equal(list.scrollTop, 73, "saved scroll is reapplied after focus-induced scrolling");
  dom.window.close();
});

test("filter includes ancestor paths and forces collapsed disclosures truthfully expanded without mutation", () => {
  assert.deepEqual(filterInstanceTree(instances, "grand").map((i) => i.instance), ["root", "child", "grand"]);
  const dom = new JSDOM(`<!doctype html><body><button id="d"></button></body>`);
  const disclosure = dom.window.document.getElementById("d");
  let toggles = 0;
  configureDisclosure(disclosure, {
    instance: "root", collapsed: true, filtering: true, onToggle: () => toggles++,
  });
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  assert.equal(disclosure.getAttribute("aria-disabled"), "true");
  assert.equal(disclosure.disabled, true);
  disclosure.click();
  assert.equal(toggles, 0, "forced filter expansion never mutates persisted collapse state");
  dom.window.close();
});

test("first-launch deferred roster owns both completion orders but rejects a true switch", async () => {
  const owns = (current, dispatchGeneration = 1, currentGeneration = 1) => rosterResponseOwns({
    dispatchWorkspace: "", responseWorkspace: "wsA", currentWorkspace: current,
    dispatchGeneration, currentGeneration,
  });
  // Roster resolves first: current selection is still empty and adopts wsA.
  assert.equal(owns(""), true);
  // Hierarchy resolves first: it silently adopted the SAME server workspace.
  await Promise.resolve();
  assert.equal(owns("wsA"), true);
  // A real selection/generation change must still reject the old response.
  assert.equal(owns("wsB"), false);
  assert.equal(owns("wsA", 1, 2), false);
});
