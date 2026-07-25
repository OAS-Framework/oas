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

/** True when a keydown target is an editable control (typing surface). */
export function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

/** Guard for the shell's window-level engine dispatch: unmodified chords
 * (bare keys, or shift-only — both produce text) must never fire from
 * editable controls; a user-recorded bare-key binding would otherwise steal
 * typed characters (e.g. rebinding a stage switch to "a" discarding an open
 * spawn form). Modifier-based shortcuts still pass. The engine itself will
 * gain this guard via the approved contract addendum; the shell guard keeps
 * the invariant regardless. */
export function allowsEngineDispatch(e, { isMac = /mac/i.test(navigator.platform || "") } = {}) {
  if (!isEditableTarget(e.target)) return true;
  const c = chordFromEvent(e, isMac);
  if (!c) return true; // pure-modifier keydown — nothing to dispatch anyway
  return !!(c.mod || c.ctrl || c.alt);
}

function chordsEqual(a, b, isMac) {
  if (!a || !b || a.key !== b.key || a.alt !== b.alt || a.shift !== b.shift) return false;
  if (isMac) return a.mod === b.mod && a.ctrl === b.ctrl;
  return (a.mod || a.ctrl) === (b.mod || b.ctrl);
}

/** Resolve a view keydown to an action id, or null.
 * `actions` = [{ id, chord }] where chord is the view's DEFAULT chord string.
 * Engine bindings (overrides) win; defaults apply only to actions the engine
 * reports unbound, and only when the event chord is not claimed by ANY other
 * registered action's explicit binding — a local default must never shadow
 * a chord the user deliberately bound elsewhere (review 93ff03d).
 * KNOWN LIMIT (routed to the core dev as a contract addendum): getBinding()
 * cannot distinguish "no default" from an explicit editor unbind, so
 * Backspace-unbinding a view action falls back to its local default and the
 * editor shows these actions as unbound; fixing both needs registerAction to
 * carry default-chord metadata in the engine. */
export function resolveViewKey(e, actions, { isMac = /mac/i.test(navigator.platform || ""), binding = getBinding, registered = listActions } = {}) {
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
