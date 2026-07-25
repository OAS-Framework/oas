/* oas desktop — view-local key dispatch resolved through the engine keymap.
   Views own single-key shortcuts scoped to their focused surface (hierarchy
   canvas, spawn grid): dispatch stays DOM-local so typing in inputs is never
   affected, but the CHORD each action answers to comes from the engine —
   getBinding resolves user override ?? DEFAULT_KEYMAP ?? registration
   defaultChord, and a persisted explicit unbind (Backspace in the editor)
   returns null, which makes the key DEAD here too. One source of truth
   (review 4f57091: no local chord fallback — a resolver-side default would
   resurrect explicitly unbound shortcuts and split the keymap authority
   addendum 3 unified). */
import { getBinding, parseChord, chordFromEvent } from "./keybindings.mjs";

function chordsEqual(a, b, isMac) {
  if (!a || !b || a.key !== b.key || a.alt !== b.alt || a.shift !== b.shift) return false;
  if (isMac) return a.mod === b.mod && a.ctrl === b.ctrl;
  return (a.mod || a.ctrl) === (b.mod || b.ctrl);
}

/** Resolve a view keydown to an action id, or null.
 * `actions` = [{ id }] — engine-registered actions (registerAction with
 * defaultChord). The effective chord is ENGINE-OWNED via getBinding;
 * view-local dispatch merely scopes WHERE the key fires (the focused
 * canvas/grid), never WHAT it is bound to. An action whose effective
 * binding is null (no default, or explicitly unbound) never fires. */
export function resolveViewKey(e, actions, { isMac = /mac/i.test(navigator.platform || ""), binding = getBinding } = {}) {
  const evChord = chordFromEvent(e, isMac);
  if (!evChord) return null;
  for (const a of actions) {
    const bound = parseChord(binding(a.id) || "");
    if (bound && chordsEqual(bound, evChord, isMac)) return a.id;
  }
  return null;
}
