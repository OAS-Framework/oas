// Split panes + hideable sidebar — shell wiring pins (keybindings-wiring
// house style: source-level assertions without booting Electron) plus the
// engine's default chords for the new actions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  DEFAULT_KEYMAP, TERMINAL_ALLOWLIST, parseChord, matchEvent, registerAction,
  setActiveContexts,
} from "../renderer/keybindings.mjs";
import {
  isSplitMember, wireSplitPaneSelection, requestSplit, openTabInFocusedGroup,
} from "../renderer/split-layout.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

test("split + sidebar actions have parseable default chords; splits are terminal-allowlisted", () => {
  for (const id of ["sidebar.toggle", "split.vertical", "split.horizontal", "split.close"]) {
    assert.ok(DEFAULT_KEYMAP[id], `${id} has a default chord`);
    assert.ok(parseChord(DEFAULT_KEYMAP[id]), `${id} chord parses`);
  }
  for (const id of ["split.vertical", "split.horizontal", "split.close"]) {
    assert.ok(TERMINAL_ALLOWLIST.includes(id),
      `${id} must fire inside xterm on Linux/Windows (the active pane IS a terminal)`);
  }
  // sidebar.toggle (Mod+B) must NOT be allowlisted: on non-mac its chord is
  // Ctrl+B — the tmux prefix — which belongs to the attached program.
  assert.ok(!TERMINAL_ALLOWLIST.includes("sidebar.toggle"),
    "sidebar.toggle would shadow the tmux prefix (Ctrl+B) inside xterm");
});

test("non-mac Ctrl+B inside xterm resolves to NO desktop action (tmux prefix passes through)", (t) => {
  t.after(() => setActiveContexts(new Set()));
  const offs = [
    registerAction({ id: "sidebar.toggle", label: "sb", context: "global", run: () => {} }),
    registerAction({ id: "split.vertical", label: "v", context: "tabs", run: () => {} }),
  ];
  t.after(() => offs.forEach((off) => off()));
  setActiveContexts(new Set(["tabs"]));
  assert.equal(matchEvent(
    { key: "b", ctrlKey: true, shiftKey: false, metaKey: false, altKey: false, defaultPrevented: false },
    { isMac: false, insideTerminal: true, editableTarget: false },
  ), null, "Ctrl+B reaches tmux, not sidebar.toggle");
  // outside the terminal the binding works normally
  assert.equal(matchEvent(
    { key: "b", ctrlKey: true, shiftKey: false, metaKey: false, altKey: false, defaultPrevented: false },
    { isMac: false, insideTerminal: false, editableTarget: false },
  ), "sidebar.toggle");
  // and on mac, ⌘B inside xterm still fires (⌘-chord rule)
  assert.equal(matchEvent(
    { key: "b", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false },
    { isMac: true, insideTerminal: true, editableTarget: false },
  ), "sidebar.toggle");
});

test("shell registers the split and sidebar actions and exposes them in the palette", () => {
  const src = read("renderer/shell.mjs");
  for (const id of ["sidebar.toggle", "split.vertical", "split.horizontal", "split.close"]) {
    assert.match(src, new RegExp(`id: "${id.replace(".", "\\.")}"`), `action ${id} registered`);
    assert.match(src, new RegExp(`chordDetail\\("${id.replace(".", "\\.")}"\\)`), `palette shows ${id}'s chord`);
  }
  // splits arrange TERMINAL tabs on the tab layer
  assert.match(src, /id: "split\.vertical", label: [^\n]*context: "tabs"/, "split actions live in the tabs context");
});

test("splits are terminal-only, route through editor-group transitions, and clean up on close/workspace switch", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /if \(!t \|\| t\.kind !== "terminal"\) return; \/\/ splits are terminal-only/);
  // activation routes through the SAME tab path every open uses — identity
  // resolution and dedup are untouched (soul invariant): members focus
  // their group; NEW terminal tabs open into the FOCUSED group.
  assert.match(src, /\? focusTab\(split, id\)\.split/);
  assert.match(src, /: openTabInFocusedGroup\(split, id\)\.split/);
  assert.match(src, /const removed = removeSplitTab\(split, id\)/);
  assert.match(src, /split = null; \/\/ splits are per-workspace/);
});

test("sidebar toggle is class-driven and persisted like other shell prefs", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /const SIDEBAR_HIDDEN_KEY = "oas-desktop-sidebar-hidden"/);
  assert.match(src, /classList\.toggle\("sidebar-hidden", on\)/);
  assert.match(src, /localStorage\.getItem\(SIDEBAR_HIDDEN_KEY\) === "1"/, "restored at startup");
  const css = read("renderer/shell.css");
  assert.match(css, /#app\.sidebar-hidden #sidebar \{ display: none; \}/);
});

test("split CSS turns group cells into flex cells in both orientations", () => {
  const css = read("renderer/shell.css");
  assert.match(css, /#tabhost\.split-row \{ display: flex; flex-direction: row; \}/);
  assert.match(css, /#tabhost\.split-col \{ display: flex; flex-direction: column; \}/);
  // split cells leave absolute positioning so flex can size them; xterm's
  // FitAddon then refits via each tab's ResizeObserver
  assert.match(css, /\.tab-pane\.split-cell \{ position: relative; inset: auto; flex: 1 1 0; min-width: 0; min-height: 0; \}/);
  assert.match(css, /\.group-cell \{ display: flex; flex-direction: column; flex: 1 1 0/);
});

test("split default chords match REAL key events — Shift+\\ arrives as event.key '|'", (t) => {
  t.after(() => setActiveContexts(new Set()));
  const offs = [
    registerAction({ id: "split.vertical", label: "v", context: "tabs", run: () => {} }),
    registerAction({ id: "split.horizontal", label: "h", context: "tabs", run: () => {} }),
  ];
  t.after(() => offs.forEach((off) => off()));
  setActiveContexts(new Set(["tabs"]));
  // mac: physical Cmd+Shift+\ — the browser reports the SHIFTED character
  assert.equal(matchEvent(
    { key: "|", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, defaultPrevented: false },
    { isMac: true, insideTerminal: false, editableTarget: false },
  ), "split.horizontal");
  assert.equal(matchEvent(
    { key: "\\", metaKey: true, shiftKey: false, ctrlKey: false, altKey: false, defaultPrevented: false },
    { isMac: true, insideTerminal: false, editableTarget: false },
  ), "split.vertical");
  // non-mac inside xterm: allowlisted, Ctrl plays Mod
  assert.equal(matchEvent(
    { key: "|", ctrlKey: true, shiftKey: true, metaKey: false, altKey: false, defaultPrevented: false },
    { isMac: false, insideTerminal: true, editableTarget: false },
  ), "split.horizontal");
});

test("clicking or focusing a visible non-selected split pane selects ITS tab (review 8443068)", () => {
  const dom = new JSDOM(`<div id="tabhost"><div id="a"></div><div id="b"></div></div>`);
  const { document } = dom.window;
  const paneA = document.getElementById("a");
  const paneB = document.getElementById("b");
  let split = { orientation: "row", nextId: 3, groups: [{ id: 1, tabs: [1], activeTab: 1 }, { id: 2, tabs: [2], activeTab: 2 }], focusedGroup: 2 };
  let activeTab = 2;
  const wire = (paneEl, id) => wireSplitPaneSelection(paneEl, {
    isMember: () => isSplitMember(split, id),
    isActive: () => activeTab === id,
    select: () => { activeTab = id; },
  });
  const offA = wire(paneA, 1);
  wire(paneB, 2);
  // pane B is selected; pointerdown into pane A must select tab 1 — so a
  // subsequent tabs.close/split action targets the terminal being used
  paneA.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(activeTab, 1, "pointer into pane A selects tab 1");
  // keyboard path: focus entering pane B selects tab 2
  paneB.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
  assert.equal(activeTab, 2, "focus into pane B selects tab 2");
  // an already-active pane is a no-op; a non-member pane never selects
  paneB.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(activeTab, 2);
  split = { orientation: "row", nextId: 3, groups: [{ id: 2, tabs: [2], activeTab: 2 }], focusedGroup: 2 };
  paneA.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(activeTab, 2, "non-member pane does not select");
  // disposer removes the listeners
  split = { orientation: "row", nextId: 3, groups: [{ id: 1, tabs: [1], activeTab: 1 }, { id: 2, tabs: [2], activeTab: 2 }], focusedGroup: 2 };
  offA();
  activeTab = 2;
  paneA.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(activeTab, 2, "disposed pane no longer selects");
});

test("closing the active split member activates the model-chosen successor, not the newest tab", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /const splitSuccessor = activeTab === id \? removed\.successor : null/,
    "successor comes from the model's removeSplitTab (adjacent in the group, else neighbor group's active)");
  assert.match(src, /if \(splitSuccessor != null && tabs\.has\(splitSuccessor\)\) \{\n\s*activateTab\(splitSuccessor\)/,
    "split successor wins over fallbackTabForContext");
});

test("shell wires pane selection on every tab pane through activateTab", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /wireSplitPaneSelection\(paneEl, \{/);
  assert.match(src, /isActive: \(\) => activeTab === id/);
  assert.match(src, /select: \(\) => activateTab\(id\)/);
});

test("activateTab keeps single-selection a11y per surface: one aria-selected per tablist", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /t\.triggerEl\.setAttribute\("aria-selected", String\(on\)\)/);
  assert.match(src, /t\.paneEl\.classList\.toggle\("active", on\)/,
    "shown group-active panes stay .active so their ResizeObservers refit");
});

test("splitPane → activateTab → open terminal fills the NEW group (review ddbbe3b blocker)", () => {
  // Reproduce the shell's REAL sequence with the model transitions the
  // wiring pins bind it to: splitPane runs requestSplit (focuses the new
  // empty group) and then re-renders via activateTab with keepGroupFocus —
  // which must NOT route through focusTab, or group focus snaps back to the
  // source member and the next terminal opens in the ORIGINAL group,
  // leaving the empty group unreachable.
  const src = read("renderer/shell.mjs");
  assert.match(src, /activateTab\(activeTab, \{ keepGroupFocus: true \}\)/,
    "splitPane re-renders without moving group focus");
  assert.match(src, /split && !keepGroupFocus\) \{/,
    "activateTab honors keepGroupFocus before focusTab/openTabInFocusedGroup");
  // model-level replay of the full sequence
  let split = requestSplit(null, "row", [1, 2], 1).split;
  const newGroup = split.focusedGroup;
  // splitPane's re-render: activateTab(activeTab, { keepGroupFocus: true })
  // skips the member transition entirely — group focus stays on the new group
  assert.equal(split.focusedGroup, newGroup);
  // the next terminal the user opens (roster/palette/quick-open → addTab →
  // activateTab without keepGroupFocus → openTabInFocusedGroup)
  split = openTabInFocusedGroup(split, 3).split;
  const g2 = split.groups.find((g) => g.id === newGroup);
  assert.deepEqual(g2.tabs, [3], "the new terminal fills the freshly created group");
  assert.equal(g2.activeTab, 3);
  // and a subsequent split from that member repeats the pattern
  const again = requestSplit(split, "row", null, null).split;
  assert.equal(again.groups.length, 3);
  assert.equal(again.focusedGroup, again.groups[2].id, "the newest group is focused again");
  const filled = openTabInFocusedGroup(again, 4).split;
  assert.deepEqual(filled.groups[2].tabs, [4]);
});
