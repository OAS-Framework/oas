// oas desktop — Quick Open for souls (Mod+P): a VS Code Quick Open-style
// overlay to find a SOUL and instantiate it. Data source is the Spawn
// view's roster (GET /api/agents); selecting a soul hands off to the Spawn
// view's own form flow (no second spawn form here — CLI degradation is the
// Spawn view's to render).
//
// Terminal policy (documented decision): app.quickOpenSouls is NOT in the
// engine's TERMINAL_ALLOWLIST. On macOS ⌘P fires inside xterm by the
// ⌘-chord policy; on Linux/Windows Ctrl+P inside xterm belongs to the
// shell's history navigation and must reach the pty.
import { createOverlayPicker, subsequenceScore } from "./overlay-picker.mjs";

/** Pure row computation — exported for tests. Attached-mode souls are shown
 * (they exist) but marked: selection still routes to the Spawn view, whose
 * card explains why they are not spawnable standalone. */
export function quickOpenRows(agents, query, { onPick } = {}) {
  const q = String(query || "").trim();
  const rows = [];
  for (const a of agents) {
    const text = `${a.name} ${a.repoName || ""} ${a.description || ""}`;
    const sc = q ? subsequenceScore(text, q) : 0;
    if (sc == null) continue;
    const attached = a.work === "attached";
    rows.push({
      sc,
      label: a.name,
      detail: [a.repoName, attached ? "attached only" : "", a.description]
        .filter(Boolean).join(" · "),
      dot: null,
      run: () => onPick({ name: a.name, agentsRoot: a.agentsRoot }),
    });
  }
  rows.sort((a, b) => a.sc - b.sc || String(a.label).localeCompare(String(b.label)));
  return rows.slice(0, 12);
}

/**
 * @param {object} deps
 * @param {() => Promise<{agents: Array}>} deps.loadSouls  the Spawn view's
 *        data source (GET /api/agents, workspace-scoped by the caller)
 * @param {(soul: {name: string, agentsRoot?: string}) => void} deps.onPick
 *        open the Spawn view with this soul's form preselected
 */
export function createQuickOpen({ loadSouls, onPick, doc }) {
  return createOverlayPicker({
    placeholder: "Find a soul to spawn…",
    ariaLabel: "Quick open souls",
    doc,
    loadItems: async () => { try { return await loadSouls(); } catch { return { agents: [] }; } },
    computeRows: (souls, raw) => quickOpenRows(souls?.agents || [], raw, { onPick }),
  });
}
