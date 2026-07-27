// Editor-group split UI — DOM projection (split-dom.mjs), tab-strip split
// controls (split-controls.mjs), context-gated button dispatch (runAction),
// and shell/index.html wiring pins for the clickable affordances.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  requestSplit, focusTab, openTabInFocusedGroup, removeSplitTab, MAX_SPLIT_GROUPS,
} from "../renderer/split-layout.mjs";
import { projectSplitDom } from "../renderer/split-dom.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { registerAction, setActiveContexts, runAction } from "../renderer/keybindings.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

function dom() {
  return new JSDOM(`
    <div id="tabstrip">
      <div id="tabbar-row">
        <div id="tabbar" role="tablist"></div>
        <div id="tab-actions"><button id="b"></button></div>
      </div>
    </div>
    <div id="tabhost"></div>`);
}

function shellEls(doc) {
  const emptyEl = doc.createElement("div");
  emptyEl.className = "split-empty";
  return {
    tabhost: doc.getElementById("tabhost"),
    tabstrip: doc.getElementById("tabstrip"),
    tabbar: doc.getElementById("tabbar"),
    actionsEl: doc.getElementById("tab-actions"),
    actionsHome: doc.getElementById("tabbar-row"),
    emptyEl,
  };
}

function makeTabs(doc, ids) {
  const tabs = new Map();
  const tabbar = doc.getElementById("tabbar");
  const tabhost = doc.getElementById("tabhost");
  for (const id of ids) {
    const tabEl = doc.createElement("div");
    tabEl.className = "tab";
    tabEl.id = `tab-wrap-${id}`;
    const triggerEl = doc.createElement("button");
    triggerEl.id = `tab-${id}`;
    triggerEl.setAttribute("role", "tab");
    tabEl.append(triggerEl);
    tabbar.append(tabEl);
    const paneEl = doc.createElement("div");
    paneEl.id = `tabpanel-${id}`;
    tabhost.append(paneEl);
    tabs.set(id, { tabEl, triggerEl, paneEl });
  }
  return tabs;
}

// ── requirement: each group renders its own tab strip above its pane ─────

test("splitting projects one group-cell per group: group strip with the REAL tab elements + the group's panes; empty group shows the placeholder", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  // user is on tab 2 and splits right — the shell's splitPane path
  let split = requestSplit(null, "row", [1, 2, 3], 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  assert.ok(els.tabhost.classList.contains("split-row"));
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.equal(cells.length, 2);
  const bar1 = cells[0].querySelector(":scope > .group-tabbar");
  assert.equal(bar1.getAttribute("role"), "tablist", "each group strip is its own tablist");
  // ALL existing tabs stay together in group 1's strip (human requirement)
  assert.deepEqual([...bar1.querySelectorAll(".tab")].map((t) => t.id),
    ["tab-wrap-1", "tab-wrap-2", "tab-wrap-3"]);
  // and their panes park inside group 1's cell
  for (const id of [1, 2, 3]) assert.equal(tabs.get(id).paneEl.parentNode, cells[0]);
  assert.equal(doc.getElementById("tabbar").querySelector(".tab"), null, "flat strip emptied");
  // the new (focused) empty group shows the placeholder, no tabs
  assert.equal(els.emptyEl.parentNode, cells[1]);
  // the split controls ride the FOCUSED group's strip
  assert.equal(els.actionsEl.parentNode, cells[1].querySelector(".group-tabbar"));
});

test("new tab opens into the FOCUSED group's strip; the old flat strip stays hidden (no phantom chrome row)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  projectSplitDom(els, split, true, [...tabs]);
  // the top strip row is HIDDEN while split — the PR #44 phantom empty bar
  assert.ok(els.tabstrip.classList.contains("split-hidden"),
    "the shell-level #tabstrip must not render as an empty bar during a split");
  split = openTabInFocusedGroup(split, 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.equal(cells[1].querySelector(".tab"), tabs.get(2).tabEl, "tab 2 opened into the focused group");
  assert.equal(tabs.get(2).paneEl.parentNode, cells[1]);
  assert.equal(els.emptyEl.parentNode, null, "placeholder leaves once the group fills");
});

test("projection is idempotent — an in-place node is never re-inserted (pointerdown-tear guard)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  split = openTabInFocusedGroup(split, 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  const snapshot = els.tabhost.innerHTML;
  const moves = [];
  for (const [id, t] of tabs) {
    for (const el of [t.tabEl, t.paneEl]) {
      const { after } = el;
      el.after = (...a) => { moves.push(id); return after.apply(el, a); };
    }
  }
  projectSplitDom(els, split, true, [...tabs]);
  assert.deepEqual(moves, [], "no node moved on a re-render");
  assert.equal(els.tabhost.innerHTML, snapshot);
});

test("switching the active tab within a group re-projects without dismantling the split", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1, 2], 1).split;
  split = openTabInFocusedGroup(split, 3).split;
  split = focusTab(split, 2).split; // switch within group 1
  projectSplitDom(els, split, true, [...tabs]);
  assert.equal(els.tabhost.querySelectorAll(":scope > .group-cell").length, 2,
    "the split persists across tab switches (tab-layer ownership)");
  // controls follow group focus back to group 1
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.equal(els.actionsEl.parentNode, cells[0].querySelector(".group-tabbar"));
});

test("collapsing to one group restores the flat layout byte-identical to the pre-split DOM (regression guard)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  const stripBefore = els.tabstrip.outerHTML;
  const hostBefore = els.tabhost.outerHTML;
  let split = requestSplit(null, "row", [1, 2, 3], 2).split;
  split = openTabInFocusedGroup(split, 3 /* member: focuses, no dup */).split;
  projectSplitDom(els, split, true, [...tabs]);
  // the split closes (split.close action → model null)
  projectSplitDom(els, null, false, [...tabs]);
  assert.equal(els.tabstrip.outerHTML, stripBefore, "strip DOM byte-identical to non-split state");
  assert.equal(els.tabhost.outerHTML, hostBefore, "host DOM byte-identical to non-split state");
  assert.ok(!els.tabstrip.classList.contains("split-hidden"));
});

test("covering the split (non-member tab active) hides it without destroying group state; re-activating restores it", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  split = openTabInFocusedGroup(split, 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  projectSplitDom(els, split, false, [...tabs]); // covered — e.g. souls-context tab
  assert.equal(els.tabhost.querySelector(".group-cell"), null);
  assert.ok(!els.tabstrip.classList.contains("split-hidden"));
  assert.deepEqual([...els.tabbar.querySelectorAll(".tab")].map((t) => t.id),
    ["tab-wrap-1", "tab-wrap-2"], "flat strip in creation order while covered");
  projectSplitDom(els, split, true, [...tabs]); // back on the tab layer
  assert.equal(els.tabhost.querySelectorAll(":scope > .group-cell").length, 2, "split re-materializes");
});

test("a removed group's cell disappears; survivors keep their cells (stable data-group identity)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  split = openTabInFocusedGroup(split, 2).split;
  split = requestSplit(split, "row", null, null).split;
  split = openTabInFocusedGroup(split, 3).split; // [1] [2] [3]
  projectSplitDom(els, split, true, [...tabs]);
  const keepCell = els.tabhost.querySelector('.group-cell[data-group="1"]');
  ({ split } = removeSplitTab(split, 2));
  // tab 2's nodes leave the DOM the way closeTab removes them
  tabs.get(2).tabEl.remove(); tabs.get(2).paneEl.remove(); tabs.delete(2);
  projectSplitDom(els, split, true, [...tabs]);
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.equal(cells.length, 2);
  assert.equal(cells[0], keepCell, "surviving group keeps its cell node");
});

test("projection preserves keyboard focus on the focused tab trigger across regrouping (a11y)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  tabs.get(2).triggerEl.focus();
  let split = requestSplit(null, "row", [1, 2], 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  assert.equal(doc.activeElement, tabs.get(2).triggerEl, "moving the tab into its group keeps focus");
  projectSplitDom(els, null, false, [...tabs]);
  assert.equal(doc.activeElement, tabs.get(2).triggerEl, "restoring the flat strip keeps focus");
});

// ── clickable controls share the actions' gating ─────────────────────────

test("splitControlsState mirrors the split actions' gating (terminal-only, cap, empty group, close)", () => {
  assert.equal(splitControlsState(null, 1, "terminal", false).visible, false);
  assert.equal(splitControlsState(null, 1, "file", true).visible, false);
  assert.equal(splitControlsState(null, null, null, true).visible, false);
  // flat: both splits enabled, close disabled
  assert.deepEqual(splitControlsState(null, 1, "terminal", true),
    { visible: true, splitRow: true, splitCol: true, close: false });
  // an empty group waiting: same-orientation split disabled, re-orient enabled
  const withEmpty = requestSplit(null, "row", [1], 1).split;
  assert.deepEqual(splitControlsState(withEmpty, 1, "terminal", true),
    { visible: true, splitRow: false, splitCol: true, close: true });
  // at the cap: only re-orientation stays enabled
  let full = requestSplit(null, "row", [1], 1).split;
  for (let id = 2; full.groups.length < MAX_SPLIT_GROUPS || full.groups.some((g) => !g.tabs.length); id++) {
    if (full.groups.some((g) => !g.tabs.length)) full = openTabInFocusedGroup(full, id).split;
    else full = requestSplit(full, "row", null, null).split;
  }
  assert.equal(full.groups.length, MAX_SPLIT_GROUPS);
  assert.deepEqual(splitControlsState(full, 1, "terminal", true),
    { visible: true, splitRow: false, splitCol: true, close: true });
});

test("runAction dispatches a registered action only in an active context (buttons = chords)", (t) => {
  t.after(() => setActiveContexts(new Set()));
  const calls = [];
  const offs = [
    registerAction({ id: "test.tabsOnly", label: "t", context: "tabs", run: () => calls.push("tabs") }),
    registerAction({ id: "test.global", label: "g", context: "global", run: () => calls.push("global") }),
  ];
  t.after(() => offs.forEach((off) => off()));
  setActiveContexts(new Set()); // stage visible, tab layer hidden
  assert.equal(runAction("test.tabsOnly"), false, "context-gated exactly like chord dispatch");
  assert.equal(runAction("test.global"), true);
  setActiveContexts(new Set(["tabs"]));
  assert.equal(runAction("test.tabsOnly"), true);
  assert.equal(runAction("test.missing"), false);
  assert.deepEqual(calls, ["global", "tabs"]);
});

// ── shell/index.html wiring pins (house style: source-level assertions) ──

test("index.html ships the split buttons and shell wires the group projection through runAction", () => {
  const html = read("renderer/index.html");
  for (const id of ["tab-actions", "split-right", "split-down", "split-close", "sidebar-restore", "tabstrip", "tabbar-row"]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html has #${id}`);
  }
  assert.ok(!/id="pane-tabs"/.test(html), "the PR #44 pane-tabs row is gone (phantom chrome fix)");
  for (const a of ["split.vertical", "split.horizontal", "split.close", "sidebar.toggle"]) {
    assert.match(html, new RegExp(`data-action="${a.replace(".", "\\.")}"`), `${a} button is chord-titled`);
  }
  const src = read("renderer/shell.mjs");
  assert.match(src, /runAction\("sidebar\.toggle"\)/, "sidebar buttons run the registered action");
  assert.match(src, /\["split-right", "split\.vertical"\]/, "split buttons map to the registered actions");
  assert.match(src, /splitControlsState\(split, activeTab/, "button gating derives from the shared model");
  assert.match(src, /projectSplitDom\(/, "group projection via split-dom");
  assert.match(src, /label">Sidebar</, "rail-footer Sidebar button");
  const css = read("renderer/shell.css");
  assert.match(css, /#sidebar-restore \{ display: none; \}/);
  assert.match(css, /#app\.sidebar-hidden #sidebar-restore \{/);
  assert.match(css, /#tabstrip\.split-hidden \{ display: none; \}/,
    "the top strip disappears while the split renders per-group strips");
  assert.match(css, /\.group-cell \{[^}]*flex: 1 1 0/, "group cells share the host track");
});
