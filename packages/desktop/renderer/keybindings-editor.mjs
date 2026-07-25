// oas desktop — keyboard shortcuts editor (shell-owned dialog).
//
// Like the palette overlay: plain DOM, semantic tokens from theme.css /
// shell.css, keyboard-first, ARIA dialog. Lists every registered action
// grouped by context with its effective chord; click a chord to record a
// new one (Esc cancels, Backspace unbinds), conflicts warned inline via
// findConflict, per-row reset, reset-all.

import {
  listActions, getBinding, setBinding, resetBinding, resetAllBindings,
  onKeymapChange, findConflict, formatChord, chordFromEvent, chordToString,
  DEFAULT_KEYMAP,
} from "./keybindings.mjs";

const CONTEXT_LABELS = {
  global: "Global",
  tabs: "Tabs",
  roster: "Instance roster",
  "stage:hierarchy": "Active overview",
  "stage:spawn": "Soul roster",
};

/** Group registered actions by context, stable order, for rendering. */
export function groupActions(actions = listActions()) {
  const order = ["global", "tabs", "roster", "stage:hierarchy", "stage:spawn"];
  const groups = new Map();
  for (const a of actions) {
    if (!groups.has(a.context)) groups.set(a.context, []);
    groups.get(a.context).push(a);
  }
  const sorted = [...groups.entries()].sort((x, y) => {
    const xi = order.indexOf(x[0]); const yi = order.indexOf(y[0]);
    return (xi < 0 ? order.length : xi) - (yi < 0 ? order.length : yi);
  });
  for (const [, list] of sorted) list.sort((a, b) => a.label.localeCompare(b.label));
  return sorted.map(([context, list]) => ({
    context, label: CONTEXT_LABELS[context] || context, actions: list,
  }));
}

export function createKeybindingsEditor({ doc = document, isMac } = {}) {
  let overlay = null;
  let offKeymap = null;
  let restoreFocus = null;
  let stopRecording = null; // teardown for an in-flight chord capture

  function endRecording() {
    if (stopRecording) { const stop = stopRecording; stopRecording = null; stop(); }
  }

  function close() {
    if (!overlay) return;
    endRecording(); // the capture listener must not outlive the dialog
    offKeymap?.(); offKeymap = null;
    overlay.remove(); overlay = null;
    try { restoreFocus?.focus?.(); } catch { /* focus target may be gone */ }
    restoreFocus = null;
  }

  function open() {
    if (overlay) return;
    restoreFocus = doc.activeElement;
    overlay = doc.createElement("div");
    overlay.className = "palette-overlay kb-overlay";
    overlay.innerHTML = `
      <div class="kb-editor" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="kb-head">
          <h2 class="kb-title">Keyboard shortcuts</h2>
          <button type="button" class="kb-reset-all">Reset all</button>
          <button type="button" class="kb-close" aria-label="Close shortcuts editor">✕</button>
        </div>
        <p class="kb-hint">Click a shortcut to record a new one — Esc cancels, Backspace unbinds.</p>
        <div class="kb-body"></div>
      </div>`;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !stopRecording) { e.preventDefault(); close(); return; }
      if (e.key !== "Tab" || stopRecording) return;
      // aria-modal promises focus containment — wrap Tab/Shift+Tab inside the
      // dialog (same handling as the workspace-switcher modal).
      const dialog = overlay.querySelector(".kb-editor");
      const focusable = [...dialog.querySelectorAll("button:not([disabled])")]
        .filter((el) => !el.hidden && el.tabIndex >= 0);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (doc.activeElement === last || !dialog.contains(doc.activeElement))) {
        e.preventDefault(); first.focus();
      }
    });
    doc.body.append(overlay);
    overlay.querySelector(".kb-close").addEventListener("click", close);
    overlay.querySelector(".kb-reset-all").addEventListener("click", () => { endRecording(); resetAllBindings(); });

    const body = overlay.querySelector(".kb-body");

    const render = () => {
      endRecording(); // a rerender invalidates any in-flight capture
      body.innerHTML = "";
      const groups = groupActions();
      if (!groups.length) {
        const d = doc.createElement("div");
        d.className = "kb-empty";
        d.textContent = "No actions registered.";
        body.append(d);
        return;
      }
      for (const group of groups) {
        const h = doc.createElement("h3");
        h.className = "kb-context";
        h.textContent = group.label;
        body.append(h);
        for (const action of group.actions) body.append(row(action));
      }
    };

    const row = (action) => {
      const el = doc.createElement("div");
      el.className = "kb-row";
      const chordStr = getBinding(action.id);
      const isDefault = chordStr === (DEFAULT_KEYMAP[action.id] ?? null);
      el.innerHTML = `
        <span class="kb-label"></span>
        <span class="kb-conflict" role="status"></span>
        <button type="button" class="kb-chord"></button>
        <button type="button" class="kb-reset" title="Reset to default">↺</button>`;
      el.querySelector(".kb-label").textContent = action.label;
      const chordBtn = el.querySelector(".kb-chord");
      chordBtn.textContent = chordStr ? formatChord(chordStr, isMac) : "unbound";
      chordBtn.classList.toggle("kb-unbound", !chordStr);
      chordBtn.setAttribute("aria-label", `Change shortcut for ${action.label}, currently ${chordStr ? formatChord(chordStr, isMac) : "unbound"}`);
      const resetBtn = el.querySelector(".kb-reset");
      resetBtn.hidden = isDefault;
      resetBtn.setAttribute("aria-label", `Reset shortcut for ${action.label} to default`);
      resetBtn.addEventListener("click", () => resetBinding(action.id));

      const conflictEl = el.querySelector(".kb-conflict");
      const existing = chordStr ? findConflict(chordStr, action.context, action.id, isMac) : null;
      if (existing) conflictEl.textContent = `Also bound to “${existing.label}”`;

      chordBtn.addEventListener("click", () => startRecording(action, chordBtn, conflictEl));
      return el;
    };

    const startRecording = (action, btn, conflictEl) => {
      if (stopRecording) return;
      btn.classList.add("kb-recording");
      btn.textContent = "Press keys…";
      const onKey = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") { endRecording(); render(); return; }
        if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          endRecording(); setBinding(action.id, null); return;
        }
        const chord = chordFromEvent(e, isMac);
        if (!chord) return; // bare modifier — keep recording
        const conflict = findConflict(chord, action.context, action.id, isMac);
        if (conflict) conflictEl.textContent = `Also bound to “${conflict.label}”`;
        endRecording();
        setBinding(action.id, chordToString(chord));
      };
      stopRecording = () => {
        doc.removeEventListener("keydown", onKey, true);
        btn.classList.remove("kb-recording");
      };
      doc.addEventListener("keydown", onKey, true);
    };

    offKeymap = onKeymapChange(render);
    render();
    overlay.querySelector(".kb-close").focus();
  }

  return {
    open,
    close,
    toggle: () => (overlay ? close() : open()),
    isOpen: () => !!overlay,
  };
}
