/**
 * Diff viewer — desktop-app view contract: mount(el, ctx) / unmount().
 *
 * ctx = { api(pathname, opts), openFile(path), openTerminal(instance),
 *         instance: "<instance name>" }   (instance provided by the shell)
 *
 * Data source: GET /api/diff/<instance>?staged=0|1 →
 *   { repo, branch, files:[{path,status,additions,deletions}], diff }
 *
 * Renders: file list with +/- stats; per-file unified OR side-by-side view
 * with syntax highlighting for all file kinds (language from extension).
 */
import hljs from "highlight.js";

const EXT_LANG = {
  mjs: "javascript", cjs: "javascript", js: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", sh: "bash",
  bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", json: "json",
  html: "xml", xml: "xml", css: "css", scss: "scss", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp", sql: "sql",
  toml: "ini", ini: "ini", md: "markdown", markdown: "markdown",
};
const langOf = (path) => EXT_LANG[(path.split(".").pop() || "").toLowerCase()];

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function hl(code, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
  } catch { /* fall through */ }
  return escapeHtml(code);
}

/** Parse a unified git diff into [{ path, oldPath, hunks:[{header, lines:[{kind:'+'|'-'|' ', text, oldNo, newNo}]}] }]. */
export function parseUnifiedDiff(diff) {
  const files = [];
  let file = null, hunk = null, oldNo = 0, newNo = 0;
  for (const line of String(diff).split("\n")) {
    const fm = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (fm) { file = { path: fm[2], oldPath: fm[1], hunks: [] }; files.push(file); hunk = null; continue; }
    if (!file) continue;
    const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hm) {
      oldNo = Number(hm[1]); newNo = Number(hm[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // meta lines (index, ---/+++, mode)
    if (line.startsWith("+")) hunk.lines.push({ kind: "+", text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith("-")) hunk.lines.push({ kind: "-", text: line.slice(1), oldNo: oldNo++, newNo: null });
    // only a literal leading space is context — the trailing "" from splitting
    // a newline-terminated diff is NOT a line, and "\\ No newline..." is skipped
    else if (line.startsWith(" ")) hunk.lines.push({ kind: " ", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    // "\ No newline at end of file" and other markers are skipped
  }
  return files;
}

/** Pair up hunk lines for side-by-side: runs of -/+ align row-by-row. */
export function pairForSideBySide(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === " ") { rows.push({ left: l, right: l }); i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].kind === "-") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "+") adds.push(lines[i++]);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++)
      rows.push({ left: dels[j] || null, right: adds[j] || null });
  }
  return rows;
}

const STYLE = `
.dfv { font: 13px/1.5 "SF Mono", Menlo, monospace; padding: 12px 16px 48px; }
.dfv-head { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; margin-bottom: 10px; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.dfv-head .branch { font-weight: 600; }
.dfv-head button { font: inherit; cursor: pointer; }
.dfv-files { list-style: none; margin: 0 0 16px; padding: 0; font-family: -apple-system, "Segoe UI", sans-serif; font-size: 13px; }
.dfv-files li { padding: 2px 4px; cursor: pointer; border-radius: 4px; display: flex; gap: 8px; }
.dfv-files li:hover { background: #8881; }
.dfv-files .st { width: 1.2em; text-align: center; font-weight: 700; }
.dfv-files .st-A { color: #2a2; } .dfv-files .st-D { color: #c33; } .dfv-files .st-M, .dfv-files .st-R { color: #b80; }
.dfv-files .plus { color: #2a2; } .dfv-files .minus { color: #c33; }
.dfv-file { margin-bottom: 20px; border: 1px solid #8883; border-radius: 6px; overflow: hidden; }
.dfv-file > .fname { padding: 6px 10px; background: #8881; font-weight: 600; }
.dfv table { border-collapse: collapse; width: 100%; table-layout: fixed; }
.dfv td { padding: 0 8px; vertical-align: top; white-space: pre-wrap; word-break: break-all; }
.dfv td.no { width: 3.5em; text-align: right; opacity: .5; user-select: none; white-space: nowrap; }
.dfv tr.add td.code, .dfv td.cell-add { background: rgba(80, 200, 100, .14); }
.dfv tr.del td.code, .dfv td.cell-del { background: rgba(230, 80, 80, .13); }
.dfv tr.hunk td { background: #8882; opacity: .7; padding: 2px 8px; }
.dfv .hljs { background: transparent; }
`;

function fileSection(doc, f, stat, sideBySide) {
  const lang = langOf(f.path);
  const wrap = doc.createElement("div");
  wrap.className = "dfv-file";
  wrap.id = `dfv-${f.path.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const plus = stat?.additions != null ? `+${stat.additions}` : "";
  const minus = stat?.deletions != null ? `−${stat.deletions}` : "";
  let html = `<div class="fname">${escapeHtml(f.path)} <span class="plus">${plus}</span> <span class="minus">${minus}</span></div><table>`;
  for (const h of f.hunks) {
    if (sideBySide) {
      html += `<tr class="hunk"><td colspan="4">${escapeHtml(h.header)}</td></tr>`;
      for (const r of pairForSideBySide(h.lines)) {
        // left column shows OLD line numbers, right column NEW line numbers
        const cell = (l, side) => l
          ? `<td class="no">${(side === "L" ? l.oldNo : l.newNo) ?? ""}</td><td class="code ${l.kind === "+" ? "cell-add" : l.kind === "-" ? "cell-del" : ""}">${hl(l.text, lang)}</td>`
          : `<td class="no"></td><td class="code"></td>`;
        html += `<tr>${cell(r.left, "L")}${cell(r.right, "R")}</tr>`;
      }
    } else {
      html += `<tr class="hunk"><td colspan="3">${escapeHtml(h.header)}</td></tr>`;
      for (const l of h.lines) {
        const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : "";
        html += `<tr class="${cls}"><td class="no">${l.oldNo ?? ""}</td><td class="no">${l.newNo ?? ""}</td><td class="code">${l.kind === " " ? "" : escapeHtml(l.kind)}${hl(l.text, lang)}</td></tr>`;
      }
    }
  }
  wrap.innerHTML = html + "</table>";
  return wrap;
}

/* Per-mount state — the shell opens one diff tab per workspace+instance, so
   each mount owns its nodes and returns its disposer (the view host prefers
   it); exported unmount() disposes all active mounts (harness compat). */
const mounts = new Set();

export async function mount(el, ctx) {
  const doc = el.ownerDocument;
  const root = doc.createElement("div");
  root.className = "dfv";
  const style = doc.createElement("style");
  style.textContent = STYLE;
  el.append(style, root);
  const dispose = () => {
    if (!mounts.has(dispose)) return;
    mounts.delete(dispose);
    root.remove();
    style.remove();
  };
  mounts.add(dispose);

  const state = { staged: false, sideBySide: false };
  // Request-generation guard: rapid staged/worktree toggles start concurrent
  // fetches, and a SLOW OLD response must not overwrite a newer render (or a
  // disposed mount). Each render owns a monotonic token, captures its mode
  // before the await, and discards its completion if it no longer owns the
  // mount — same pattern as the shell's c40b1b2/1eef32f fixes.
  let renderGen = 0;
  const render = async () => {
    const gen = ++renderGen;
    const mode = { staged: state.staged, sideBySide: state.sideBySide };
    const owns = () => gen === renderGen && mounts.has(dispose);
    root.innerHTML = `<div class="dfv-head">Loading diff for ${escapeHtml(ctx.instance || "")}…</div>`;
    let data;
    try {
      // ctx.ws (from the shell's workspace-keyed picker) scopes the server-side
      // instance lookup — same-named instances exist across workspaces.
      const ws = ctx.ws ? `&ws=${encodeURIComponent(ctx.ws)}` : "";
      const res = await ctx.api(`/api/diff/${encodeURIComponent(ctx.instance)}?staged=${mode.staged ? 1 : 0}${ws}`);
      if (!owns()) return; // superseded or disposed while awaiting
      data = res && res.json ? await res.json() : res;
      if (!owns()) return;
      if (data.error) throw new Error(data.error);
    } catch (e) {
      if (!owns()) return;
      root.innerHTML = `<div class="dfv-head">Diff unavailable: ${escapeHtml(e.message || String(e))}</div>`;
      return;
    }
    root.innerHTML = "";
    const head = doc.createElement("div");
    head.className = "dfv-head";
    head.innerHTML = `<span class="branch">${escapeHtml(data.branch || "")}</span><span>${escapeHtml(data.repo || "")}</span>`;
    const mkBtn = (label, on) => { const b = doc.createElement("button"); b.textContent = label; b.addEventListener("click", on); head.append(b); };
    mkBtn(mode.staged ? "show worktree" : "show staged", () => { state.staged = !state.staged; render(); });
    mkBtn(mode.sideBySide ? "unified" : "side-by-side", () => { state.sideBySide = !state.sideBySide; render(); });
    root.append(head);

    if (!data.files.length) {
      const p = doc.createElement("div");
      p.textContent = mode.staged ? "Nothing staged." : "Working tree clean.";
      root.append(p);
      return;
    }
    const list = doc.createElement("ul");
    list.className = "dfv-files";
    const statOf = new Map(data.files.map((f) => [f.path, f]));
    for (const f of data.files) {
      const li = doc.createElement("li");
      li.innerHTML = `<span class="st st-${escapeHtml(f.status)}">${escapeHtml(f.status)}</span><span>${escapeHtml(f.path)}</span>` +
        `<span class="plus">${f.additions != null ? "+" + f.additions : ""}</span><span class="minus">${f.deletions != null ? "−" + f.deletions : ""}</span>`;
      li.addEventListener("click", () => {
        doc.getElementById(`dfv-${f.path.replace(/[^A-Za-z0-9_-]/g, "_")}`)?.scrollIntoView({ behavior: "smooth" });
      });
      list.append(li);
    }
    root.append(list);
    for (const f of parseUnifiedDiff(data.diff)) root.append(fileSection(doc, f, statOf.get(f.path), mode.sideBySide));
  };
  await render();
  return dispose;
}

export function unmount() {
  for (const d of [...mounts]) d();
}
