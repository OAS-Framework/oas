/* oas desktop — view-local key dispatch resolved through the engine keymap.
   Views own single-key shortcuts scoped to their focused surface (hierarchy
   canvas, spawn grid): dispatch stays DOM-local so typing in inputs is never
   affected, but the CHORD each action answers to comes from the engine
   (getBinding — user overrides included), falling back to the view's default
   only while the action has no engine binding. This keeps view keys
   rebindable from the shortcuts editor: a rebound action answers its new
   chord and its old default stops firing; a default never shadows another
   action's explicit binding on the same key. */
import { getBinding, parseChord, chordFromEvent, listActions } from "./keybindings.mjs";

function chordsEqual(a, b, isMac) {
  if (!a || !b || a.key !== b.key || a.alt !== b.alt || a.shift !== b.shift) return false;
  if (isMac) return a.mod === b.mod && a.ctrl === b.ctrl;
  return (a.mod || a.ctrl) === (b.mod || b.ctrl);
}

/** Resolve a view keydown to an action id, or null.
 * `actions` = [{ id }] (registered engine actions). The chord each action
 * answers to is ENGINE-OWNED (DEFAULT_KEYMAP default, user override, or
 * explicit unbind via getBinding) — view-local dispatch merely scopes WHERE
 * the key fires (the focused canvas/grid), never WHAT it is bound to. An
 * optional legacy `chord` field is honored only for actions the engine has
 * no knowledge of at all (not registered and no default) — kept for tests.
 */
export function resolveViewKey(e, actions, { isMac = /mac/i.test(navigator.platform || ""), binding = getBinding, registered = listActions } = {}) {
  const evChord = chordFromEvent(e, isMac);
  if (!evChord) return null;
  const unbound = [];
  for (const a of actions) {
    const bound = parseChord(binding(a.id) || "");
    if (bound) {
      if (chordsEqual(bound, evChord, isMac)) return a.id;
    } else if (a.chord) {
      unbound.push(a);
    }
  }
  if (!unbound.length) return null;
  // the event chord may be explicitly bound to a NON-view action (global or
  // another context); the local default yields to that deliberate binding
  const viewIds = new Set(actions.map((a) => a.id));
  for (const other of registered()) {
    if (viewIds.has(other.id)) continue;
    const bound = parseChord(binding(other.id) || "");
    if (bound && chordsEqual(bound, evChord, isMac)) return null;
  }
  for (const a of unbound) {
    if (chordsEqual(parseChord(a.chord || ""), evChord, isMac)) return a.id;
  }
  return null;
}
