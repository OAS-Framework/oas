// Editor-group split model for the desktop shell's terminal tab layer —
// pure state transitions (no DOM) so the semantics are unit-testable.
//
// VS Code editor-group semantics (feature rework of the PR #41/#44 split
// model, which arranged individual tabs and dismantled on tab switch):
// a split creates PERSISTENT GROUPS. Each group owns an ordered tab list
// and its own active tab; the split layout belongs to the tab LAYER, not
// to any tab — switching tabs within a group, or focusing another group,
// never dismantles the split. New terminal tabs open into the FOCUSED
// group; group focus follows the last activated tab.
//
// The model is null (single flat strip — renders exactly as the non-split
// shell always did) or
//   { orientation: "row"|"col", nextId,
//     groups: [{ id, tabs: [tabId...], activeTab }], focusedGroup }
// Group `id`s are model-local monotonic keys (stable DOM identity across
// re-renders); `tabs` hold open terminal-tab ids in strip order.
//
// The former "pending slot absorbs the next terminal" indirection is
// DROPPED (documented decision): a fresh split simply creates an empty
// focused group — every open path (sidebar roster, palette, quick-open)
// already funnels through tab activation, so the new tab lands in that
// focused group with no special pending state.
//
// Renderer-side group count is a UX bound only; the hard pty/viewer cap
// lives in the Electron main process (terminal-resource-cap lesson).
export const MAX_SPLIT_GROUPS = 4;

/** Start a split, or add one more group to an existing split (and/or
 * re-orient it). From the flat state, `seedTabs` (the tab layer's current
 * terminal tabs, creation order) become group 1 with `activeId` active —
 * ALL existing tabs stay together in the original group (human requirement)
 * — and a NEW EMPTY group is created after it and FOCUSED, so the next
 * terminal the user opens lands there (VS Code: the new group is the active
 * one). In an existing split the new empty group is inserted after the
 * focused group and becomes focused. No new group is created while the
 * focused group is still empty (the renderer shows one placeholder pane;
 * fill it first) or at MAX_SPLIT_GROUPS — those requests only re-orient.
 * Returns { split, changed }. */
export function requestSplit(split, orientation, seedTabs, activeId) {
  if (!split) {
    if (activeId == null || !seedTabs?.includes(activeId)) return { split, changed: false };
    return {
      split: {
        orientation,
        nextId: 3,
        groups: [
          { id: 1, tabs: [...seedTabs], activeTab: activeId },
          { id: 2, tabs: [], activeTab: null },
        ],
        focusedGroup: 2,
      },
      changed: true,
    };
  }
  const focused = split.groups.find((g) => g.id === split.focusedGroup);
  // At most ONE empty group exists at a time (the renderer shows one
  // placeholder pane per empty group, and an unfilled group is a pending
  // user decision) — fill it before splitting again.
  if (!focused || split.groups.some((g) => !g.tabs.length)
      || split.groups.length >= MAX_SPLIT_GROUPS) {
    if (split.orientation === orientation) return { split, changed: false };
    return { split: { ...split, orientation }, changed: true };
  }
  const at = split.groups.indexOf(focused);
  const group = { id: split.nextId, tabs: [], activeTab: null };
  const groups = [...split.groups.slice(0, at + 1), group, ...split.groups.slice(at + 1)];
  return {
    split: { ...split, orientation, nextId: split.nextId + 1, groups, focusedGroup: group.id },
    changed: true,
  };
}

/** The group holding tab `id`, or null. */
export function groupOfTab(split, id) {
  return split?.groups.find((g) => g.tabs.includes(id)) ?? null;
}

/** True when tab `id` belongs to any group of `split`. */
export function isSplitMember(split, id) {
  return !!groupOfTab(split, id);
}

/** Activate tab `id` where it lives: its group's activeTab moves to it and
 * that group takes focus (group focus follows the active tab / the user's
 * last interaction). No-op ({ changed: false }) for non-members. */
export function focusTab(split, id) {
  const group = groupOfTab(split, id);
  if (!group) return { split, changed: false };
  if (group.activeTab === id && split.focusedGroup === group.id) return { split, changed: false };
  return {
    split: {
      ...split,
      groups: split.groups.map((g) => (g === group ? { ...g, activeTab: id } : g)),
      focusedGroup: group.id,
    },
    changed: true,
  };
}

/** A NEW terminal tab enters the layer: it joins the FOCUSED group at the
 * end of its strip, becomes that group's active tab, and keeps the group
 * focused. Already-member tabs are just focused (never duplicated). */
export function openTabInFocusedGroup(split, id) {
  if (!split || id == null) return { split, changed: false };
  if (isSplitMember(split, id)) return focusTab(split, id);
  return {
    split: {
      ...split,
      groups: split.groups.map((g) => (g.id === split.focusedGroup
        ? { ...g, tabs: [...g.tabs, id], activeTab: id } : g)),
    },
    changed: true,
  };
}

/** Wire pane-level selection for group cells: pointer or keyboard focus
 * entering a VISIBLE non-selected member pane must make its tab the active
 * one — otherwise the user types in pane A while tab B stays selected and
 * tabs.close / further splits target the wrong terminal. Selection must not
 * steal focus from the terminal the user just clicked, so `select` is the
 * shell's activateTab (which never moves DOM focus). Installed once per tab
 * pane at creation; the guards read live state via callbacks. */
export function wireSplitPaneSelection(paneEl, { isMember, isActive, select }) {
  const onEnter = () => {
    if (!isMember() || isActive()) return;
    select();
  };
  paneEl.addEventListener("pointerdown", onEnter);
  paneEl.addEventListener("focusin", onEnter);
  return () => {
    paneEl.removeEventListener("pointerdown", onEnter);
    paneEl.removeEventListener("focusin", onEnter);
  };
}

/** Remove a (closed) tab from its group. Returns { split, successor }:
 *  - successor is the tab to activate when the closed tab was its group's
 *    active one — its right neighbor IN THE GROUP, else its left one, else
 *    (group now empty and collapsing) the surviving neighbor GROUP's active
 *    tab. A surviving split tab must win over the shell's generic
 *    most-recent-tab fallback (an unrelated newer terminal would otherwise
 *    cover the split).
 *  - closing a group's LAST tab collapses the group; down to one group the
 *    model collapses to null (single flat strip). */
export function removeSplitTab(split, id) {
  const group = groupOfTab(split, id);
  if (!group) return { split, successor: null };
  const at = group.tabs.indexOf(id);
  const tabs = group.tabs.filter((t) => t !== id);
  let successor = group.activeTab === id
    ? (tabs[at] ?? tabs[at - 1] ?? null)
    : null;
  let groups;
  if (!tabs.length) {
    const gAt = split.groups.indexOf(group);
    groups = split.groups.filter((g) => g !== group);
    if (group.activeTab === id && groups.length) {
      const neighbor = groups[Math.min(gAt, groups.length - 1)];
      successor = neighbor.activeTab;
    }
  } else {
    groups = split.groups.map((g) => (g === group
      ? { ...g, tabs, activeTab: g.activeTab === id ? successor : g.activeTab } : g));
  }
  if (groups.length < 2) return { split: null, successor };
  const focusedGroup = groups.some((g) => g.id === split.focusedGroup)
    ? split.focusedGroup
    : (groupOfTab({ ...split, groups }, successor)?.id ?? groups[0].id);
  return { split: { ...split, groups, focusedGroup }, successor };
}
