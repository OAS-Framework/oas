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
 * callers gate on kind === "terminal". Returns { split, changed }. */
export function requestSplit(split, orientation, activeId) {
  if (activeId == null) return { split, changed: false };
  if (!split) {
    return { split: { orientation, members: [activeId], pending: 1 }, changed: true };
  }
  const size = split.members.length + split.pending;
  if (size >= MAX_SPLIT_PANES) {
    if (split.orientation === orientation) return { split, changed: false };
    return { split: { ...split, orientation }, changed: true };
  }
  return {
    split: { orientation, members: [...split.members], pending: split.pending + 1 },
    changed: true,
  };
}

/** True when tab `id` occupies a pane of `split`. */
export function isSplitMember(split, id) {
  return !!split && split.members.includes(id);
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

/** Remove a (closed) tab from the split. Collapses to null when fewer than
 * two panes (members + pending) would remain, or when no member remains —
 * closing a split returns cleanly to the single-pane layout. */
export function removeSplitTab(split, id) {
  if (!split || !split.members.includes(id)) return split;
  const members = split.members.filter((m) => m !== id);
  if (!members.length || members.length + split.pending < 2) return null;
  return { ...split, members };
}
