// Split-pane layout model for the desktop shell's terminal tab layer — pure
// state transitions (no DOM) so the semantics are unit-testable.
//
// A split shows several TERMINAL tabs side by side (orientation "row") or
// stacked (orientation "col") inside #tabhost. The model is a plain object
//   { orientation: "row"|"col", members: [tabId...], pending: n }
// or null (single-pane). `members` are open terminal-tab ids in visual
// order; `pending` counts empty slots waiting to be filled by the NEXT
// terminal the user opens/activates (sidebar row, palette, quick-open) —
// splits host instance terminals chosen exactly the way tabs are, so the
// existing identity-resolution and tab-dedup chain is untouched: a split
// slot absorbs the resolved TAB, never a name.
//
// Renderer-side pane count is a UX bound only; the hard pty/viewer cap
// lives in the Electron main process (terminal-resource-cap lesson).
export const MAX_SPLIT_PANES = 4;

/** Start a split, or add one more empty slot to an existing split (and/or
 * re-orient it). `activeId` must be the currently active terminal tab —
 * callers gate on kind === "terminal". At most ONE pending slot exists at a
 * time: the renderer owns a single placeholder element, so a second empty
 * slot could not be shown — the user fills the open slot before splitting
 * again. Returns { split, changed }. */
export function requestSplit(split, orientation, activeId) {
  if (activeId == null) return { split, changed: false };
  if (!split) {
    return { split: { orientation, members: [activeId], pending: 1 }, changed: true };
  }
  const size = split.members.length + split.pending;
  if (split.pending > 0 || size >= MAX_SPLIT_PANES) {
    if (split.orientation === orientation) return { split, changed: false };
    return { split: { ...split, orientation }, changed: true };
  }
  return {
    split: { orientation, members: [...split.members], pending: 1 },
    changed: true,
  };
}

/** True when tab `id` occupies a pane of `split`. */
export function isSplitMember(split, id) {
  return !!split && split.members.includes(id);
}

/** Wire pane-level selection for split cells: pointer or keyboard focus
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

/** Offer tab `id` to the pending slot (called on terminal-tab activation).
 * Existing members are never absorbed twice — activating a member just
 * focuses it. Returns { split, absorbed }. */
export function absorbTab(split, id) {
  if (!split || split.pending <= 0 || split.members.includes(id) || id == null) {
    return { split, absorbed: false };
  }
  return {
    split: { ...split, members: [...split.members, id], pending: split.pending - 1 },
    absorbed: true,
  };
}

/** The member to activate when split member `id` closes: its right/lower
 * neighbor, else its left/upper one — a surviving split pane must win over
 * the shell's generic most-recent-tab fallback (an unrelated newer terminal
 * would otherwise cover the split). Null when `id` is not a member or no
 * other member survives. */
export function adjacentSplitMember(split, id) {
  if (!split) return null;
  const at = split.members.indexOf(id);
  if (at < 0) return null;
  return split.members[at + 1] ?? split.members[at - 1] ?? null;
}

/** Remove a (closed) tab from the split. Collapses to null when fewer than
 * two panes (members + pending) would remain, or when no member remains —
 * closing a split returns cleanly to the single-pane layout. */
export function removeSplitTab(split, id) {
  if (!split || !split.members.includes(id)) return split;
  const members = split.members.filter((m) => m !== id);
  if (!members.length || members.length + split.pending < 2) return null;
  return { ...split, members };
}
