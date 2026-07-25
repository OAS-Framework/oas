/* oas desktop — view-local key dispatch resolved through the engine keymap.
   Views own single-key shortcuts scoped to their focused surface (hierarchy
   canvas, spawn grid): dispatch stays DOM-local so typing in inputs is never
   affected, but the CHORD each action answers to comes from the engine
   (getBinding — user overrides included), falling back to the view's default
   only while the action has no engine binding. This keeps view keys
   rebindable from the shortcuts editor: a rebound action answers its new
   chord and its old default stops firing; a default never shadows another
   action's explicit binding on the same key. */
import { getBinding, parseChord, chordFromEvent } from "./keybindings.mjs";

function chordsEqual(a, b, isMac) {
  if (!a || !b || a.key !== b.key || a.alt !== b.alt || a.shift !== b.shift) return false;
  if (isMac) return a.mod === b.mod && a.ctrl === b.ctrl;
  return (a.mod || a.ctrl) === (b.mod || b.ctrl);
}

/** Resolve a view keydown to an action id, or null.
 * `actions` = [{ id, chord }] where chord is the view's DEFAULT chord string.
 * Engine bindings (overrides) win; defaults apply only to actions the engine
 * reports unbound, and only when no bound action already claims the event. */
export function resolveViewKey(e, actions, { isMac = /mac/i.test(navigator.platform || ""), binding = getBinding } = {}) {
  const evChord = chordFromEvent(e, isMac);
  if (!evChord) return null;
  const unbound = [];
  for (const a of actions) {
    const bound = parseChord(binding(a.id) || "");
    if (bound) {
      if (chordsEqual(bound, evChord, isMac)) return a.id;
    } else {
      unbound.push(a);
    }
  }
  for (const a of unbound) {
    if (chordsEqual(parseChord(a.chord || ""), evChord, isMac)) return a.id;
  }
  return null;
}
