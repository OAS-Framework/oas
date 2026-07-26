/* oas desktop — command palette (⌘K).
   One input, two result kinds: instances (default; fuzzy jump-to-terminal)
   and commands (also matched by name — ">" prefix restricts to commands).
   Overlay chrome + fuzzy machinery live in overlay-picker.mjs (shared with
   Quick Open); this module owns only the palette's row semantics. */
import { createOverlayPicker, subsequenceScore } from "./overlay-picker.mjs";

export function isPaletteShortcut(e, insideTerminal = false) {
  if (String(e.key || "").toLowerCase() !== "k" || e.altKey || e.shiftKey) return false;
  // Cmd-K is shell-owned on macOS. Ctrl-K is shell-owned on Windows/Linux
  // only outside xterm; inside xterm it belongs to the attached program.
  if (e.metaKey && !e.ctrlKey) return true;
  if (e.ctrlKey && !e.metaKey) return !insideTerminal;
  return false;
}

/** Pure row computation — exported for tests. `instances` is the roster,
 * `commands` the static command list, `raw` the input value. */
export function paletteRows(instances, commands, raw, { openTerminal } = {}) {
  const cmdMode = raw.startsWith(">");
  const q = (cmdMode ? raw.slice(1) : raw).trim();
  const rows = [];
  if (!cmdMode) {
    for (const inst of instances) {
      const text = `${inst.instance} ${inst.agent || ""} ${inst.repoName || ""}`;
      const sc = q ? subsequenceScore(text, q) : (inst.running ? -1 : 0);
      if (q && sc == null) continue; // null = no match (prefix scores are negative)
      rows.push({
        sc,
        label: inst.instance,
        detail: [inst.agent, inst.branch].filter(Boolean).join(" · "),
        dot: !!inst.running,
        run: () => openTerminal(inst.instance),
      });
    }
  }
  for (const c of commands) {
    const sc = q ? subsequenceScore(c.label, q) : 0;
    if (sc == null) continue;
    // detail may be a function so chord labels stay live against the
    // current keymap (rebinding in the editor updates the next render).
    const detail = typeof c.detail === "function" ? c.detail() : (c.detail || "");
    rows.push({ sc: sc + (cmdMode ? 0 : 50), label: c.label, detail, dot: null, run: c.run });
  }
  rows.sort((a, b) => a.sc - b.sc);
  return rows.slice(0, 12);
}

export function createPalette({ loadInstances, openTerminal, commands = [] }) {
  return createOverlayPicker({
    placeholder: 'Jump to an instance… (">" for commands)',
    ariaLabel: "Command palette",
    loadItems: async () => { try { return await loadInstances(); } catch { return []; } },
    computeRows: (instances, raw) => paletteRows(instances || [], commands, raw, { openTerminal }),
  });
}
