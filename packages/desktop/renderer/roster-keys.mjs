/* oas desktop — sidebar roster tree keyboard policy (pure).
   The persistent instance roster is a tree: Up/Down walk the VISIBLE rows,
   Right expands (or moves down when already open/leaf), Left collapses (or
   jumps to the parent row), Home/End jump, Enter is the row button's native
   activation. These are DOM-local focus keys (roving tabindex), NOT global
   chords — only "focus the roster" is a registered keybinding action.
   Extracted so the policy is unit-testable without booting the shell. */

/** Decide the tree action for a keydown on a roster row.
 * `row` = { hasChildren, collapsed }. Returns null for keys the tree does
 * not own (they bubble: Enter activates the button natively). */
export function rosterKeyAction(event, row = {}) {
  switch (event.key) {
    case "ArrowDown": return { type: "move", delta: 1 };
    case "ArrowUp": return { type: "move", delta: -1 };
    case "Home": return { type: "move", to: "first" };
    case "End": return { type: "move", to: "last" };
    case "ArrowRight":
      if (row.hasChildren && row.collapsed) return { type: "expand" };
      return { type: "move", delta: 1 };
    case "ArrowLeft":
      if (row.hasChildren && !row.collapsed) return { type: "collapse" };
      return { type: "parent" };
    default: return null;
  }
}

/** Resolve a move action to a target index over `count` visible rows,
 * clamped (tree navigation does not wrap — matching VS Code's explorer). */
export function moveTarget(action, index, count) {
  if (!count) return -1;
  if (action.to === "first") return 0;
  if (action.to === "last") return count - 1;
  const next = index + (action.delta || 0);
  return Math.max(0, Math.min(count - 1, next));
}

/** Roving tabindex assignment: exactly one row is tabbable — the focused
 * one, else the first. Returns the tabbable index. */
export function rovingIndex(count, focusedIndex) {
  if (!count) return -1;
  return focusedIndex >= 0 && focusedIndex < count ? focusedIndex : 0;
}
