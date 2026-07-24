/* oas desktop — command palette (⌘K).
   One input, two result kinds: instances (default; fuzzy jump-to-terminal)
   and commands (also matched by name — ">" prefix restricts to commands).
   Shell-owned chrome: plain DOM, semantic tokens, keyboard-first
   (arrows/Enter/Esc), aria roles for the listbox pattern. */

export function isPaletteShortcut(e, insideTerminal = false) {
  if (String(e.key || "").toLowerCase() !== "k" || e.altKey || e.shiftKey) return false;
  // Cmd-K is shell-owned on macOS. Ctrl-K is shell-owned on Windows/Linux
  // only outside xterm; inside xterm it belongs to the attached program.
  if (e.metaKey && !e.ctrlKey) return true;
  if (e.ctrlKey && !e.metaKey) return !insideTerminal;
  return false;
}

export function createPalette({ loadInstances, openTerminal, commands = [] }) {
  let overlay = null;
  let gen = 0; // load generation — a stale instance list must not paint over a newer open

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  async function open() {
    if (overlay) return;
    const myGen = ++gen;
    overlay = document.createElement("div");
    overlay.className = "palette-overlay";
    overlay.innerHTML = `
      <div class="palette" role="dialog" aria-label="Command palette">
        <input class="palette-input" placeholder="Jump to an instance… (&quot;&gt;&quot; for commands)"
               aria-label="Search instances and commands" autocomplete="off" spellcheck="false">
        <div class="palette-list" role="listbox"></div>
      </div>`;
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);
    const input = overlay.querySelector(".palette-input");
    const list = overlay.querySelector(".palette-list");
    input.focus();

    let instances = [];
    let items = [];   // current result rows: { label, detail, dot, run }
    let active = 0;

    const score = (text, q) => {
      // simple subsequence fuzzy match; lower = better, -1 = no match
      const t = text.toLowerCase(); const s = q.toLowerCase();
      let ti = 0, gaps = 0;
      for (const ch of s) {
        const found = t.indexOf(ch, ti);
        if (found < 0) return -1;
        gaps += found - ti; ti = found + 1;
      }
      return gaps + (t.startsWith(s) ? -100 : 0);
    };

    const render = () => {
      list.innerHTML = "";
      if (!items.length) {
        const d = document.createElement("div");
        d.className = "palette-empty";
        d.textContent = "No matches.";
        list.append(d);
        return;
      }
      items.forEach((it, i) => {
        const row = document.createElement("div");
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
      list.children[active]?.scrollIntoView({ block: "nearest" });
    };

    const update = () => {
      const raw = input.value;
      const cmdMode = raw.startsWith(">");
      const q = (cmdMode ? raw.slice(1) : raw).trim();
      const rows = [];
      if (!cmdMode) {
        for (const inst of instances) {
          const text = `${inst.instance} ${inst.agent || ""} ${inst.repoName || ""}`;
          const sc = q ? score(text, q) : (inst.running ? -1 : 0);
          if (sc < 0 && q) continue;
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
        const sc = q ? score(c.label, q) : 0;
        if (sc < 0) continue;
        rows.push({ sc: sc + (cmdMode ? 0 : 50), label: c.label, detail: "", dot: null, run: c.run });
      }
      rows.sort((a, b) => a.sc - b.sc);
      items = rows.slice(0, 12);
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
    try { instances = await loadInstances(); } catch { instances = []; }
    // the palette may have been closed (or reopened) while the roster loaded
    if (myGen !== gen || !overlay) return;
    update();
  }

  return { open, close, toggle: () => (overlay ? close() : open()) };
}
