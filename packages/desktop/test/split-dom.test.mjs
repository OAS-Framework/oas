// Split UI completions — DOM projections (split-dom.mjs), tab-strip split
// controls (split-controls.mjs), context-gated button dispatch (runAction),
// and shell/index.html wiring pins for the clickable affordances.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { requestSplit, absorbTab, removeSplitTab, MAX_SPLIT_PANES } from "../renderer/split-layout.mjs";
import { renderSplitLayout, projectTabStrip } from "../renderer/split-dom.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { registerAction, setActiveContexts, runAction } from "../renderer/keybindings.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

function dom() {
  return new JSDOM(`<div id="pane-tabs" hidden></div><div id="tabbar" role="tablist"></div><div id="tabhost"></div>`);
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

// ── requirement 2: the split seeds from the CURRENT tab, end to end ─────

test("splitting seeds the first pane with the ACTIVE tab's pane (DOM regression)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const tabhost = doc.getElementById("tabhost");
  const emptyEl = doc.createElement("div");
  emptyEl.className = "split-empty";
  // user is on tab 2 and splits right — exactly the shell's splitPane path
  const activeId = 2;
  let split = requestSplit(null, "row", activeId).split;
  assert.deepEqual(split.members, [activeId], "model seeds members with the active tab");
  renderSplitLayout(tabhost, emptyEl, split, true, (id) => tabs.get(id)?.paneEl || null);
  assert.ok(tabhost.classList.contains("split-row"));
  // The CURRENT tab's pane is the FIRST visible flex cell. Non-member panes
  // stay in #tabhost but hidden (display:none — no flex cell), so the
  // visual pane order is the DOM order of member panes + placeholder: the
  // seeded pane precedes the pending placeholder.
  const order = (a, b) => !!(a.compareDocumentPosition(b) & 4); // a before b
  assert.equal(emptyEl.parentNode, tabhost, "placeholder shown while pending");
  assert.ok(order(tabs.get(activeId).paneEl, emptyEl),
    "the tab the user split FROM occupies the first pane (before the placeholder)");
  // absorbing the next terminal keeps the seeded pane first
  split = absorbTab(split, 3).split;
  renderSplitLayout(tabhost, emptyEl, split, true, (id) => tabs.get(id)?.paneEl || null);
  assert.ok(order(tabs.get(2).paneEl, tabs.get(3).paneEl), "seeded pane stays before the absorbed pane");
  assert.equal(emptyEl.parentNode, null, "placeholder leaves once the slot fills");
});

test("renderSplitLayout is idempotent — an in-place pane is never re-inserted", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const tabhost = doc.getElementById("tabhost");
  const emptyEl = doc.createElement("div");
  const split = { orientation: "row", members: [1, 2], pending: 0 };
  renderSplitLayout(tabhost, emptyEl, split, true, (id) => tabs.get(id)?.paneEl || null);
  const before = [...tabhost.children];
  // spy: a second render must not move any node (pointerdown-tear guard)
  let moved = 0;
  const orig = tabs.get(1).paneEl.after;
  for (const t of tabs.values()) {
    const el = t.paneEl;
    const append = el.appendChild;
    el.appendChild = (...a) => { moved++; return append.apply(el, a); };
  }
  renderSplitLayout(tabhost, emptyEl, split, true, (id) => tabs.get(id)?.paneEl || null);
  assert.deepEqual([...tabhost.children], before, "order unchanged");
  assert.equal(moved, 0);
  void orig;
});

test("renderSplitLayout off restores nothing split-specific (non-split regression)", () => {
  const { window } = dom();
  const doc = window.document;
  makeTabs(doc, [1]);
  const tabhost = doc.getElementById("tabhost");
  const emptyEl = doc.createElement("div");
  renderSplitLayout(tabhost, emptyEl, null, true, () => null);
  assert.ok(!tabhost.classList.contains("split-row") && !tabhost.classList.contains("split-col"));
  assert.equal(emptyEl.parentNode, null);
});

// ── requirement 3: the tab strip aligns with the split ──────────────────

test("projectTabStrip groups member tabs in PANE ORDER in the dedicated pane row; non-members stay in the tabbar", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const tabbar = doc.getElementById("tabbar");
  const paneTabs = doc.getElementById("pane-tabs");
  // active tab 2 split, pending slot open; tabs 1 and 3 are non-members
  const split = { orientation: "row", members: [2], pending: 1 };
  projectTabStrip(paneTabs, tabbar, split, true, [...tabs]);
  assert.equal(paneTabs.hidden, false);
  const groups = [...paneTabs.querySelectorAll(":scope > .tab-group")];
  assert.deepEqual(groups.map((g) => g.dataset.group), ["pane:2", "pending"],
    "pane row holds ONLY pane groups, in pane order");
  assert.equal(groups[0].querySelector("#tab-wrap-2"), tabs.get(2).tabEl);
  assert.equal(groups[1].children.length, 0, "pending group is an empty spacer");
  assert.equal(groups[1].getAttribute("aria-hidden"), "true");
  // non-members keep their flat look in the ordinary tabbar row — they must
  // NOT share the pane row's width track (alignment invariant, review 59fa415)
  assert.deepEqual([...tabbar.children], [tabs.get(1).tabEl, tabs.get(3).tabEl]);
  // absorb tab 3: it gets ITS pane group after pane 2's; spacer leaves
  const s2 = absorbTab(split, 3).split;
  projectTabStrip(paneTabs, tabbar, s2, true, [...tabs]);
  assert.deepEqual([...paneTabs.querySelectorAll(":scope > .tab-group")].map((g) => g.dataset.group),
    ["pane:2", "pane:3"]);
  assert.deepEqual([...tabbar.children], [tabs.get(1).tabEl]);
});

test("pane groups divide the SAME width track as the panes — nothing else shares the pane row", () => {
  // JSDOM has no layout engine, so the alignment invariant is pinned
  // structurally: with N members + pending the pane row contains exactly
  // those flex children and nothing else (controls/non-members live in the
  // tabbar row), and the CSS gives every pane group `flex: 1 1 0` in a row
  // whose width equals #tabhost's column — equal shares over equal panes.
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3, 4]);
  const paneTabs = doc.getElementById("pane-tabs");
  const tabbar = doc.getElementById("tabbar");
  const split = { orientation: "row", members: [2, 4], pending: 1 };
  projectTabStrip(paneTabs, tabbar, split, true, [...tabs]);
  const children = [...paneTabs.children];
  assert.equal(children.length, split.members.length + split.pending,
    "one pane-row child per pane — no controls, no rest group, no stray nodes");
  assert.ok(children.every((c) => c.classList.contains("tab-group-pane")));
  const css = read("renderer/shell.css");
  assert.match(css, /#pane-tabs > \.tab-group \{ display: flex; flex: 1 1 0;/,
    "every pane group takes an equal flex share of the full-width row");
  assert.match(css, /#tab-actions \{ display: flex;[^}]*flex: none/,
    "split controls are outside the pane track");
});

test("projectTabStrip 'col' keeps grouping semantics: group order left→right = pane order top→bottom", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const tabbar = doc.getElementById("tabbar");
  const paneTabs = doc.getElementById("pane-tabs");
  const split = { orientation: "col", members: [2, 1], pending: 0 };
  projectTabStrip(paneTabs, tabbar, split, true, [...tabs]);
  assert.ok(paneTabs.classList.contains("split-strip-col"));
  const groups = [...paneTabs.querySelectorAll(":scope > .tab-group-pane")];
  assert.deepEqual(groups.map((g) => g.dataset.group), ["pane:2", "pane:1"]);
});

test("ending the split restores the flat strip in tab-creation order (non-split regression) and drops closed members' groups", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const tabbar = doc.getElementById("tabbar");
  const paneTabs = doc.getElementById("pane-tabs");
  const flatBefore = [...tabbar.children];
  let split = { orientation: "row", members: [2, 3], pending: 0 };
  projectTabStrip(paneTabs, tabbar, split, true, [...tabs]);
  // member 3 closes → its group must disappear with it
  split = removeSplitTab(split, 3);
  assert.equal(split, null, "collapses below two panes");
  projectTabStrip(paneTabs, tabbar, split, true, [...tabs]);
  assert.equal(paneTabs.hidden, true);
  assert.equal(paneTabs.querySelector(".tab-group"), null, "no groups survive the split");
  assert.deepEqual([...tabbar.children], flatBefore, "flat strip renders exactly as before");
  // covering the split (non-member active) also restores the flat strip
  projectTabStrip(paneTabs, tabbar, { orientation: "row", members: [1, 2], pending: 0 }, true, [...tabs]);
  projectTabStrip(paneTabs, tabbar, { orientation: "row", members: [1, 2], pending: 0 }, false, [...tabs]);
  assert.deepEqual([...tabbar.children], flatBefore);
  assert.equal(paneTabs.hidden, true);
});

test("projectTabStrip preserves keyboard focus on the focused tab trigger across regrouping (a11y)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const tabbar = doc.getElementById("tabbar");
  const paneTabs = doc.getElementById("pane-tabs");
  tabs.get(2).triggerEl.focus();
  assert.equal(doc.activeElement, tabs.get(2).triggerEl);
  projectTabStrip(paneTabs, tabbar, { orientation: "row", members: [2], pending: 1 }, true, [...tabs]);
  assert.equal(doc.activeElement, tabs.get(2).triggerEl, "moving the tab into its group keeps focus");
  projectTabStrip(paneTabs, tabbar, null, false, [...tabs]);
  assert.equal(doc.activeElement, tabs.get(2).triggerEl, "restoring the flat strip keeps focus");
});

// ── requirement 1: clickable controls share the actions' gating ─────────

test("splitControlsState mirrors the split actions' gating (terminal-only, cap, pending, close)", () => {
  // hidden off the tab layer / on non-terminal tabs
  assert.equal(splitControlsState(null, 1, "terminal", false).visible, false);
  assert.equal(splitControlsState(null, 1, "file", true).visible, false);
  assert.equal(splitControlsState(null, null, null, true).visible, false);
  // single pane: both splits enabled, close disabled
  assert.deepEqual(splitControlsState(null, 1, "terminal", true),
    { visible: true, splitRow: true, splitCol: true, close: false });
  // pending slot open: same-orientation split disabled (would be a no-op), re-orient enabled
  const pending = { orientation: "row", members: [1], pending: 1 };
  assert.deepEqual(splitControlsState(pending, 1, "terminal", true),
    { visible: true, splitRow: false, splitCol: true, close: true });
  // at the cap: only re-orientation stays enabled
  const full = { orientation: "row", members: [1, 2, 3, 4], pending: 0 };
  assert.equal(full.members.length, MAX_SPLIT_PANES);
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

test("index.html ships the split buttons, the sidebar restore edge button, and shell wires them through runAction", () => {
  const html = read("renderer/index.html");
  for (const id of ["tab-actions", "split-right", "split-down", "split-close", "sidebar-restore", "tabstrip", "pane-tabs", "tabbar-row"]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html has #${id}`);
  }
  // buttons carry data-action so applyChordTitles suffixes the live chord
  for (const a of ["split.vertical", "split.horizontal", "split.close", "sidebar.toggle"]) {
    assert.match(html, new RegExp(`data-action="${a.replace(".", "\\.")}"`), `${a} button is chord-titled`);
  }
  const src = read("renderer/shell.mjs");
  assert.match(src, /runAction\("sidebar\.toggle"\)/, "sidebar buttons run the registered action");
  assert.match(src, /\["split-right", "split\.vertical"\]/, "split buttons map to the registered actions");
  assert.match(src, /splitControlsState\(split, activeTab/, "button gating derives from the shared model");
  assert.match(src, /renderSplitLayout\(tabhost, splitEmptyEl, split/, "pane projection via split-dom");
  assert.match(src, /projectTabStrip\(paneTabsEl, tabbar, split/, "strip grouping via split-dom");
  // rail-footer sidebar toggle exists alongside the edge restore button
  assert.match(src, /label">Sidebar</, "rail-footer Sidebar button");
  // CSS: the restore button only exists while the sidebar is hidden
  const css = read("renderer/shell.css");
  assert.match(css, /#sidebar-restore \{ display: none; \}/);
  assert.match(css, /#app\.sidebar-hidden #sidebar-restore \{/);
  assert.match(css, /#pane-tabs > \.tab-group \{ display: flex; flex: 1 1 0;/);
});
