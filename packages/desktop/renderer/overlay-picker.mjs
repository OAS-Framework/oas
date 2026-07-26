// oas desktop — shared overlay picker machinery (command palette family).
// One input over a fuzzy-filtered listbox: type-to-filter, ArrowUp/Down,
// Enter runs the active row, Esc/backdrop closes. Extracted from palette.mjs
// so Quick Open (Mod+P) and the palette (Mod+K) share ONE overlay + fuzzy
// implementation instead of duplicating chrome, a11y roles, and the
// stale-load generation guard.
//
// The house fuzzy matcher: simple subsequence scoring — lower is better,
// null means no match, a prefix match gets a strong (negative) bonus.
// (No-match is null, NOT -1: the prefix bonus makes real scores negative,
// and the palette's legacy `sc < 0` no-match filter silently dropped exact
// prefix matches — fixed with this extraction.)
export function subsequenceScore(text, query) {
  const t = String(text).toLowerCase();
  const s = String(query).toLowerCase();
  let ti = 0, gaps = 0;
  for (const ch of s) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    gaps += found - ti; ti = found + 1;
  }
  return gaps + (t.startsWith(s) ? -100 : 0);
}

/**
 * @param {object} spec
 * @param {string} spec.placeholder     input placeholder text
 * @param {string} spec.ariaLabel       dialog + input accessible name
 * @param {() => Promise<any>} spec.loadItems  async data source; resolves to
 *        the picker's backing data (shape is the caller's — computeRows gets
 *        it verbatim). A load that resolves after the picker was closed or
 *        reopened must not paint (generation-guarded here).
 * @param {(data: any, query: string) => Array<{label: string, detail?: string,
 *          dot?: boolean|null, run: Function}>} spec.computeRows
 *        query → result rows, already scored/sorted/sliced by the caller.
 * @param {Document} [spec.doc]
 * @returns {{ open: Function, close: Function, toggle: Function }}
 */
export function createOverlayPicker({ placeholder, ariaLabel, loadItems, computeRows, doc = globalThis.document }) {
  let overlay = null;
  let gen = 0; // load generation — a stale item list must not paint over a newer open

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  async function open() {
    if (overlay) return;
    const myGen = ++gen;
    overlay = doc.createElement("div");
    overlay.className = "palette-overlay";
    overlay.innerHTML = `
      <div class="palette" role="dialog">
        <input class="palette-input" autocomplete="off" spellcheck="false">
        <div class="palette-list" role="listbox"></div>
      </div>`;
    overlay.querySelector(".palette").setAttribute("aria-label", ariaLabel);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    doc.body.append(overlay);
    const input = overlay.querySelector(".palette-input");
    input.placeholder = placeholder;
    input.setAttribute("aria-label", ariaLabel);
    const list = overlay.querySelector(".palette-list");
    input.focus();

    let data = null;
    let items = [];   // current result rows: { label, detail, dot, run }
    let active = 0;

    const render = () => {
      list.innerHTML = "";
      if (!items.length) {
        const d = doc.createElement("div");
        d.className = "palette-empty";
        d.textContent = "No matches.";
        list.append(d);
        return;
      }
      items.forEach((it, i) => {
        const row = doc.createElement("div");
        row.className = "palette-item" + (i === active ? " active" : "");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === active));
        const dot = it.dot != null ? `<span class="pdot${it.dot ? " on" : ""}" aria-hidden="true"></span>` : `<span class="picon" aria-hidden="true">›</span>`;
        row.innerHTML = `${dot}<span class="plabel"></span><span class="pdetail"></span>`;
        row.querySelector(".plabel").textContent = it.label;
        row.querySelector(".pdetail").textContent = it.detail || "";
        row.addEventListener("mousedown", (e) => { e.preventDefault(); close(); it.run(); });
        row.addEventListener("mousemove", () => { if (active !== i) { active = i; render(); } });
        list.append(row);
      });
      list.children[active]?.scrollIntoView?.({ block: "nearest" });
    };

    const update = () => {
      items = computeRows(data, input.value);
      active = 0;
      render();
    };

    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const it = items[active];
        if (it) { close(); it.run(); }
      }
    });

    list.innerHTML = '<div class="palette-empty">Loading…</div>';
    try { data = await loadItems(); } catch { data = null; }
    // the picker may have been closed (or reopened) while the data loaded
    if (myGen !== gen || !overlay) return;
    update();
  }

  return { open, close, toggle: () => (overlay ? close() : open()) };
}
