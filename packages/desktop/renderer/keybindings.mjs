// oas desktop — keybinding engine (pure logic; unit-tested without a DOM).
//
// One shared registry: the shell/wiring code registers actions
// ({ id, label, context, run }); this module owns chord parsing, the default
// keymap, user overrides (localStorage), context scoping, and dispatch.
//
// Terminal safety (mirrors palette.mjs isPaletteShortcut and app-menu.mjs):
// when the keydown target is inside `.xterm`, on macOS ONLY chords whose
// `Mod` resolves to ⌘ (meta) may fire — explicit Ctrl chords belong to the
// attached program. On Linux/Windows the Ctrl key IS the terminal's control
// key, so only an explicit allowlist of action ids (palette, tab next/prev/
// close) may fire inside the terminal; every other Ctrl chord passes through.

const STORAGE_KEY = "oas-desktop-keymap";

// ---------------------------------------------------------------- chords

const MOD_ORDER = ["Mod", "Ctrl", "Alt", "Shift"];

// e.key values normalized so layouts/shift variants land on one spelling.
const KEY_ALIASES = new Map([
  ["+", "="], // Shift-= / numpad plus both mean the "=" binding (Mod+=)
  ["esc", "escape"],
  [" ", "space"],
  ["spacebar", "space"],
]);

export function normalizeKey(key) {
  const k = String(key || "").toLowerCase();
  return KEY_ALIASES.get(k) || k;
}

/** Parse "Mod+Shift+K" → { key, mod, ctrl, alt, shift } or null. */
export function parseChord(str) {
  if (!str || typeof str !== "string") return null;
  const parts = str.split("+");
  // "Mod+=" splits as ["Mod", "", ""] — rejoin a trailing empty pair as "+".
  if (parts.length >= 2 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts.splice(parts.length - 2, 2, "+");
  }
  const chord = { key: "", mod: false, ctrl: false, alt: false, shift: false };
  for (const raw of parts) {
    const p = raw.trim().toLowerCase();
    if (p === "mod" || p === "cmdorctrl" || p === "cmd" || p === "meta") chord.mod = true;
    else if (p === "ctrl" || p === "control") chord.ctrl = true;
    else if (p === "alt" || p === "option") chord.alt = true;
    else if (p === "shift") chord.shift = true;
    else if (p) {
      if (chord.key) return null; // two non-modifier keys — invalid
      chord.key = normalizeKey(p);
    }
  }
  if (!chord.key) return null;
  return chord;
}

const KEY_LABELS = new Map([
  ["escape", "Esc"], ["arrowup", "↑"], ["arrowdown", "↓"],
  ["arrowleft", "←"], ["arrowright", "→"], ["space", "Space"],
  ["tab", "Tab"], ["enter", "Enter"], ["backspace", "Backspace"],
]);

function keyLabel(key) {
  return KEY_LABELS.get(key) || (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
}

/** Human label for a chord (object or string). Mod = ⌘ on mac, Ctrl elsewhere. */
export function formatChord(chord, isMac = defaultIsMac()) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return "";
  if (isMac) {
    let s = "";
    if (c.ctrl) s += "⌃";
    if (c.alt) s += "⌥";
    if (c.shift) s += "⇧";
    if (c.mod) s += "⌘";
    return s + keyLabel(c.key);
  }
  const parts = [];
  if (c.mod || c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(keyLabel(c.key));
  return parts.join("+");
}

/** Canonical storage/comparison string for a chord object. */
export function chordToString(chord) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return null;
  const parts = [];
  if (c.mod) parts.push("Mod");
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(c.key === "=" ? "=" : keyLabel(c.key));
  return parts.join("+");
}

/** Build a chord object from a keydown event (for the recorder + matching).
 * On mac, metaKey is `Mod`; elsewhere ctrlKey is `Mod` (never both). */
export function chordFromEvent(e, isMac = defaultIsMac()) {
  const key = normalizeKey(e.key);
  if (!key || ["meta", "control", "alt", "shift"].includes(key)) return null;
  const chord = { key, mod: false, ctrl: false, alt: !!e.altKey, shift: !!e.shiftKey };
  if (isMac) {
    chord.mod = !!e.metaKey;
    chord.ctrl = !!e.ctrlKey;
  } else {
    chord.mod = !!e.ctrlKey; // Ctrl plays the Mod role; explicit meta ignored
  }
  return chord;
}

/** Platform-concrete equality: does `chord` (with Mod) match the event chord? */
function chordMatches(chord, evChord, isMac) {
  if (!chord || !evChord) return false;
  if (chord.key !== evChord.key || chord.alt !== evChord.alt || chord.shift !== evChord.shift) return false;
  if (isMac) return chord.mod === evChord.mod && chord.ctrl === evChord.ctrl;
  // non-mac: Mod and Ctrl are the same physical modifier
  return (chord.mod || chord.ctrl) === (evChord.mod || evChord.ctrl);
}

function defaultIsMac() {
  try {
    return /mac/i.test(navigator.platform || "");
  } catch { return false; }
}

/** True when the event target is a real editable control — plain-key chords
 * must not steal typing (mirrors the panel's logical key-routing lesson). */
function isEditableTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!target.isContentEditable;
}

// ---------------------------------------------------------------- defaults

export const DEFAULT_KEYMAP = Object.freeze({
  "app.palette": "Mod+K",
  "app.quickOpenSouls": "Mod+P",
  "app.shortcuts": "Mod+,",
  "app.themeToggle": "Mod+Shift+T",
  "stage.hierarchy": "Mod+1",
  "stage.spawn": "Mod+2",
  "tabs.next": "Ctrl+Tab",
  "tabs.prev": "Ctrl+Shift+Tab",
  "tabs.close": "Mod+W",
  "sidebar.focusFilter": "Mod+Shift+E",
  "terminal.fontBigger": "Mod+=",
  "terminal.fontSmaller": "Mod+-",
  "terminal.fontReset": "Mod+0",
});

// Action ids allowed to fire inside .xterm on Linux/Windows, where their
// chords would otherwise belong to the attached program. Allowlisting by
// action id (not chord) keeps the policy stable across user rebinds.
// app.quickOpenSouls is deliberately ABSENT: Ctrl+P inside a terminal is
// shell history navigation — it must reach the pty (⌘P on macOS still
// fires inside xterm via the ⌘-chord policy above).
export const TERMINAL_ALLOWLIST = Object.freeze([
  "app.palette", "tabs.next", "tabs.prev", "tabs.close",
]);

export const CONTEXTS = Object.freeze([
  "global", "stage:hierarchy", "stage:spawn", "roster", "tabs",
]);

// ---------------------------------------------------------------- registry

const actions = new Map();   // id -> { id, label, context, run }
let activeContexts = new Set();
const keymapListeners = new Set();

/** Register an action; returns an unregister function. Re-registering an id
 * replaces it (views re-mount). Optional `defaultChord` folds into the
 * effective keymap exactly like a DEFAULT_KEYMAP entry: user override wins,
 * an explicit editor unbind (persisted null) kills it, and getBinding /
 * findConflict / the editor all see it — view-local actions registered at
 * mount carry their defaults with the registration (contract addendum 3). */
export function registerAction({ id, label, context = "global", run, defaultChord = null }) {
  if (!id || typeof run !== "function") throw new Error("registerAction: id and run required");
  const canonical = defaultChord == null ? null : chordToString(parseChord(defaultChord));
  const action = { id, label: label || id, context, run, defaultChord: canonical };
  actions.set(id, action);
  notifyKeymapChange(); // a new default can change effective bindings
  return () => {
    if (actions.get(id) === action) { actions.delete(id); notifyKeymapChange(); }
  };
}

/** Registered actions (editor rendering). */
export function listActions() {
  return [...actions.values()];
}

export function setActiveContexts(set) {
  activeContexts = new Set(set || []);
}

function contextEligible(context) {
  return context === "global" || activeContexts.has(context);
}

// ---------------------------------------------------------------- overrides

function readOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    // Sanitize: only `null` (explicit unbind) or a parseable chord string
    // survives — anything else (numbers, objects, junk strings) is discarded
    // so a corrupted/legacy payload can never reach formatChord/matchEvent.
    const clean = {};
    for (const [id, value] of Object.entries(obj)) {
      if (value === null) clean[id] = null;
      else if (typeof value === "string") {
        const canonical = chordToString(parseChord(value));
        if (canonical) clean[id] = canonical;
      }
    }
    return clean;
  } catch { return {}; }
}

function writeOverrides(overrides) {
  try {
    if (Object.keys(overrides).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage-less */ }
}

let overrides = readOverrides();

function notifyKeymapChange() {
  for (const fn of [...keymapListeners]) { try { fn(); } catch { /* isolate listener */ } }
}

/** Effective chord string for an action (override ?? static default ??
 * registration default), or null. An explicit persisted null (editor
 * Backspace-unbind) wins over BOTH default sources. */
export function getBinding(actionId) {
  if (Object.prototype.hasOwnProperty.call(overrides, actionId)) {
    const v = overrides[actionId];
    return v == null ? null : v; // explicit null = unbound
  }
  return DEFAULT_KEYMAP[actionId] ?? actions.get(actionId)?.defaultChord ?? null;
}

/** Persist an override: chord (string or object) or null to unbind. */
export function setBinding(actionId, chordOrNull) {
  if (chordOrNull == null) {
    overrides[actionId] = null;
  } else {
    const s = chordToString(chordOrNull);
    if (!s) return;
    overrides[actionId] = s;
  }
  writeOverrides(overrides);
  notifyKeymapChange();
}

export function resetBinding(actionId) {
  if (!Object.prototype.hasOwnProperty.call(overrides, actionId)) return;
  delete overrides[actionId];
  writeOverrides(overrides);
  notifyKeymapChange();
}

export function resetAllBindings() {
  overrides = {};
  writeOverrides(overrides);
  notifyKeymapChange();
}

export function onKeymapChange(fn) {
  keymapListeners.add(fn);
  return () => keymapListeners.delete(fn);
}

// ---------------------------------------------------------------- conflicts

/** First OTHER action whose effective binding collides with `chord` in a way
 * visible from `context` (same context, or either side is global), optionally
 * excluding one action id (the one being edited). Returns the action or null. */
export function findConflict(chord, context, excludeId = null, isMac = defaultIsMac()) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return null;
  for (const action of actions.values()) {
    if (action.id === excludeId) continue;
    const bound = parseChord(getBinding(action.id) || "");
    if (!bound) continue;
    if (!chordMatches(bound, resolveForCompare(c, isMac), isMac)) continue;
    if (context === "global" || action.context === "global" || action.context === context) return action;
  }
  return null;
}

// findConflict compares two stored chords (both may use Mod); flatten one to
// the event-shaped side so chordMatches' non-mac Mod/Ctrl folding applies.
function resolveForCompare(chord, isMac) {
  if (isMac) return { ...chord };
  return { ...chord, mod: chord.mod || chord.ctrl, ctrl: false };
}

/** True for a chord with no ctrl/alt/mod modifiers (shift-only counts as
 * plain — typing produces shifted characters). Such bindings are guarded off
 * editable fields by matchEvent; the editor warns when recording one. */
export function isPlainChord(chord) {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  return !!c && !c.mod && !c.ctrl && !c.alt;
}

// ---------------------------------------------------------------- dispatch

/** Match a keydown to an eligible action id, or null. Honors context scoping
 * and the terminal policy. `opts` is for tests: { isMac, insideTerminal,
 * editableTarget } — each defaults from the environment/event. */
export function matchEvent(e, opts = {}) {
  // A consumed event stays consumed: view-local handlers (hierarchy canvas,
  // roster rows, palette input) preventDefault what they own — the engine
  // must never double-dispatch it (contract addendum a).
  if (e.defaultPrevented) return null;
  const isMac = opts.isMac ?? defaultIsMac();
  const insideTerminal = opts.insideTerminal ?? !!e.target?.closest?.(".xterm");
  const evChord = chordFromEvent(e, isMac);
  if (!evChord) return null;
  // Unmodified (or shift-only) chords belong to editable fields when one has
  // focus — a plain "b" binding must not fire while typing (addendum b).
  const editable = opts.editableTarget ?? isEditableTarget(e.target);
  const plainKey = isPlainChord(evChord);
  if (plainKey && editable) return null;

  let globalHit = null;
  let contextHit = null;
  for (const action of actions.values()) {
    if (!contextEligible(action.context)) continue;
    const bound = parseChord(getBinding(action.id) || "");
    if (!bound || !chordMatches(bound, evChord, isMac)) continue;
    if (insideTerminal) {
      if (isMac) {
        // Only ⌘-resolved chords may fire inside xterm; Ctrl belongs to the pty.
        if (!(bound.mod && evChord.mod)) continue;
        if (evChord.ctrl) continue;
      } else if (!TERMINAL_ALLOWLIST.includes(action.id)) {
        continue; // Ctrl chords belong to the attached program
      }
    }
    if (action.context === "global") globalHit = globalHit || action;
    else contextHit = contextHit || action;
  }
  const hit = contextHit || globalHit; // specific context wins over global
  return hit ? hit.id : null;
}

/** The single shell-level keydown listener body: match, prevent, run. */
export function handleKeydown(e, opts = {}) {
  const id = matchEvent(e, opts);
  if (!id) return false;
  e.preventDefault();
  const action = actions.get(id);
  try { action.run(e); } catch { /* an action must not break dispatch */ }
  return true;
}
