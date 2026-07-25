/* oas desktop — keybindings engine (TRANSITIONAL STUB).
   The real engine lands from the keybindings-core branch with the same
   surface (action registry, chord matching, localStorage overrides,
   terminal-safety policy, edit dialog in keybindings-editor.mjs). This stub
   implements the agreed contract so the wiring branch is functional and
   testable on its own; it is intended to be REPLACED wholesale when the core
   engine merges into feature/keybindings — keep the exported names stable.

   Contract (frozen with the coordinator):
     registerAction({ id, label, context, run, chord }) -> dispose()
       context: "global" | "stage:hierarchy" | "stage:spawn" | "roster" | "tabs"
       chord:   default chord string, e.g. "Mod+K", "Mod+Shift+K", "b", "+"
     setActiveContexts(set)         // shell calls on state transitions
     getBinding(actionId)           // current chord string or null
     onKeymapChange(fn) -> unsubscribe
     formatChord(chord, isMac)     // human label for palette/tooltips
     handleKeydown(e)              // THE one window keydown listener

   Chord grammar: "+"-joined tokens, last token is the key; modifiers are
   Mod (⌘ on macOS, Ctrl elsewhere), Ctrl, Alt, Shift. The literal keys
   "+" and "-" are valid final tokens ("Mod++" = Mod plus "+").

   Terminal-safety policy (generalizes the shipped isPaletteShortcut rule):
   inside xterm ONLY metaKey-based chords fire — Ctrl/Alt/plain keys belong
   to the attached program. In editable fields (input/textarea/
   contenteditable) unmodified single-key chords never fire. */

const OVERRIDES_KEY = "oas.keybindings";

const actions = new Map();          // id -> { id, label, context, run, chord }
let activeContexts = new Set(["global"]);
const keymapListeners = new Set();

function overrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}") || {}; }
  catch { return {}; }
}

function notifyKeymap() {
  for (const fn of keymapListeners) { try { fn(); } catch (e) { console.error(e); } }
}

export function registerAction({ id, label, context = "global", run, chord = null }) {
  if (!id || typeof run !== "function") throw new Error("registerAction: id and run are required");
  actions.set(id, { id, label: label || id, context, run, chord });
  notifyKeymap();
  return () => { if (actions.get(id)?.run === run) { actions.delete(id); notifyKeymap(); } };
}

export function setActiveContexts(set) {
  activeContexts = new Set(set);
  activeContexts.add("global"); // global chords stay live in every context
}

export function getActiveContexts() { return new Set(activeContexts); }

export function getBinding(actionId) {
  const a = actions.get(actionId);
  if (!a) return null;
  const o = overrides();
  return Object.prototype.hasOwnProperty.call(o, actionId) ? o[actionId] : a.chord;
}

export function setBinding(actionId, chord) {
  const o = overrides();
  if (chord === undefined) delete o[actionId]; else o[actionId] = chord;
  try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o)); } catch { /* private mode */ }
  notifyKeymap();
}

export function onKeymapChange(fn) {
  keymapListeners.add(fn);
  return () => keymapListeners.delete(fn);
}

export function listActions() { return [...actions.values()]; }

/** Parse a chord string into { key, mod, ctrl, alt, shift }. */
export function parseChord(chord) {
  if (!chord) return null;
  const s = String(chord);
  // The final token may itself be "+": split on "+" but keep a trailing key.
  const parts = s.endsWith("+") ? [...s.slice(0, -1).split("+").filter(Boolean), "+"]
    : s.split("+").filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const p = { key: key.length === 1 ? key.toLowerCase() : key, mod: false, ctrl: false, alt: false, shift: false };
  for (const raw of parts) {
    const m = raw.toLowerCase();
    if (m === "mod") p.mod = true;
    else if (m === "ctrl" || m === "control") p.ctrl = true;
    else if (m === "alt" || m === "option") p.alt = true;
    else if (m === "shift") p.shift = true;
  }
  return p;
}

/** True when the keydown event matches the chord under the platform +
 * terminal-safety policy. Exported for tests and view-local key handlers. */
export function matchesChord(e, chord, { isMac = navigator.platform.includes("Mac"), insideTerminal = false, editable = false } = {}) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return false;
  const key = String(e.key || "");
  const eventKey = key.length === 1 ? key.toLowerCase() : key;
  if (eventKey !== (c.key.length === 1 ? c.key.toLowerCase() : c.key)) return false;
  const wantMeta = c.mod && isMac;
  const wantCtrl = c.ctrl || (c.mod && !isMac);
  if (!!e.altKey !== c.alt) return false;
  // Shift is part of many printable keys ("+", "?"); only enforce it for
  // non-printable/letter keys or when the chord names it.
  if (c.shift && !e.shiftKey) return false;
  // Extra Shift only matches when the key is a shifted printable symbol
  // (e.key already reflects the shifted character, e.g. "+"); for letters,
  // digits, and named keys an unrequested Shift is a different chord.
  if (!c.shift && e.shiftKey && (c.key.length > 1 || /[a-z0-9]/i.test(c.key))) return false;
  const anyMods = wantMeta || wantCtrl || c.alt;
  if (isMac && c.mod) {
    // Mod on mac: meta strictly. But permit the Ctrl fallback OUTSIDE
    // terminals so external keyboards behave like the shipped palette rule.
    const metaMatch = e.metaKey && !e.ctrlKey;
    const ctrlMatch = e.ctrlKey && !e.metaKey && !insideTerminal;
    if (!metaMatch && !ctrlMatch) return false;
  } else {
    if (!!e.metaKey !== wantMeta) return false;
    if (!!e.ctrlKey !== wantCtrl) return false;
  }
  // Terminal safety: inside xterm only metaKey chords may fire.
  if (insideTerminal && !e.metaKey) return false;
  // Editable safety: unmodified keys type text; never steal them.
  if (editable && !anyMods) return false;
  return true;
}

/** Human-readable chord label: "⌘⇧K" on mac, "Ctrl+Shift+K" elsewhere. */
export function formatChord(chord, isMac = navigator.platform.includes("Mac")) {
  const c = parseChord(chord);
  if (!c) return "";
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key;
  if (isMac) {
    return [c.ctrl ? "⌃" : "", c.alt ? "⌥" : "", c.shift ? "⇧" : "", c.mod ? "⌘" : "", key].join("");
  }
  const mods = [];
  if (c.mod || c.ctrl) mods.push("Ctrl");
  if (c.alt) mods.push("Alt");
  if (c.shift) mods.push("Shift");
  return [...mods, key].join("+");
}

/** THE window keydown handler — the shell installs exactly one. */
export function handleKeydown(e, opts = {}) {
  // View-local handlers (e.g. hierarchy's canvas onKey) run first and
  // preventDefault; the engine never double-dispatches a consumed key.
  if (e.defaultPrevented) return false;
  const target = e.target;
  const insideTerminal = !!target?.closest?.(".xterm");
  const editable = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"
    || target.tagName === "SELECT" || target.isContentEditable === true);
  const isMac = opts.isMac ?? navigator.platform.includes("Mac");
  for (const a of actions.values()) {
    if (a.context !== "global" && !activeContexts.has(a.context)) continue;
    const chord = getBinding(a.id);
    if (!chord) continue;
    if (!matchesChord(e, chord, { isMac, insideTerminal, editable })) continue;
    e.preventDefault();
    try { a.run(e); } catch (err) { console.error(err); }
    return true;
  }
  return false;
}

/** Test seam: wipe registry + listeners (never used by the shell). */
export function _resetForTests() {
  actions.clear();
  keymapListeners.clear();
  activeContexts = new Set(["global"]);
}
