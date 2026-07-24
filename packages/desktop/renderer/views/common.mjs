/* oas desktop — shared helpers for renderer views.
   Plain ES module, DOM-only, no frameworks (contract). Views import from
   here; the shell provides ctx = { api(pathname, opts), openFile(path),
   openTerminal(instance) } per the desktop-app contract. */

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Tiny markdown for agent prose: fenced blocks, inline code, bold — the
   panel's transcript never needed more. Input is escaped first. */
export function miniMarkdown(s) {
  return escapeHtml(s)
    .replace(/```\w*\n?([\s\S]*?)```/g, (m, code) => `<code class="block">${code.replace(/\n$/, "")}</code>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}

/* Fetch JSON via the shell's ctx.api — one seam so a base-URL change (remote
   panel, port) never touches the views. Tolerates BOTH ctx.api shapes:
   a Fetch Response (harness: ctx.api = (p, o) => fetch(base + p, o)) and a
   shell that resolves already-parsed JSON (throwing on non-2xx itself).
   Throws with the server's error message when it sends one. */
export async function apiJson(ctx, pathname, opts) {
  const r = await ctx.api(pathname, opts);
  if (!r || typeof r.json !== "function") return r; // shell returned parsed data
  let d;
  try { d = await r.json(); } catch { d = {}; }
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
export function postJson(ctx, pathname, body) {
  return apiJson(ctx, pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ── workspace switching (?ws=) ──
   The backend server scopes /api/panel and /api/agents by workspace id.
   The selected workspace is shared across views and persisted, so switching
   in one view switches everywhere. Views subscribe to react to changes made
   elsewhere (e.g. a shell-level switcher can call setWorkspace too). */
const WS_KEY = "oas.desktop.ws";
const wsListeners = new Set();
/* In-memory source of truth; localStorage is persistence only (absent in
   node tests and storage-less shells). */
let wsCurrent = (() => { try { return localStorage.getItem(WS_KEY) || ""; } catch { return ""; } })();
/* Workspace GENERATION — bumped on every switch. Async paths capture it at
   dispatch and discard completions from an older generation: a deferred
   roster/agents/jira response — or a finished spawn — from workspace A must
   never paint or act after the user switched to B (same-named instances
   across workspaces make identity checks insufficient; see the ws-scoping
   lesson). */
let wsGen = 0;
export function workspaceGeneration() { return wsGen; }
export function currentWorkspace() {
  return wsCurrent;
}
export function setWorkspace(id) {
  wsCurrent = id || "";
  wsGen++;                                   // invalidate all in-flight ws-scoped work
  try { localStorage.setItem(WS_KEY, wsCurrent); } catch { /* storage-less env */ }
  for (const fn of [...wsListeners]) { try { fn(wsCurrent); } catch { /* listener error must not break others */ } }
}
/* Adopt a server-resolved workspace id WITHOUT notifying listeners — used
   when the server maps a stale/empty selection to a real workspace. */
export function adoptWorkspace(id) {
  wsCurrent = id || "";
  try { localStorage.setItem(WS_KEY, wsCurrent); } catch { /* storage-less env */ }
}
export function onWorkspaceChange(fn) {
  wsListeners.add(fn);
  return () => wsListeners.delete(fn);
}
export function wsQuery(prefix = "?") {
  const ws = currentWorkspace();
  return ws ? `${prefix}ws=${encodeURIComponent(ws)}` : "";
}

/* Per-instance endpoint path, ALWAYS scoped to the selected workspace.
   Same-named instances exist across workspaces; an unscoped request lets
   the server resolve globally — an Interrupt viewed in workspace B could
   Ctrl-C workspace A's session, and chat/jira could leak A's data. Every
   per-instance call (interrupt, chat, jira, session, keys…) must be built
   through here. `query` is the extra query string without a leading ?/&. */
export function instanceApiPath(kind, instance, query = "") {
  const q = query ? `?${query}${wsQuery("&")}` : wsQuery();
  return `/api/${kind}/${encodeURIComponent(instance)}${q}`;
}

/* Render the workspace <select> into an element; hidden when the server
   watches a single workspace. `list` is panel.workspaces. */
export function renderWorkspaceSelect(selectEl, list, current) {
  if (!Array.isArray(list) || list.length <= 1) { selectEl.style.display = "none"; return; }
  selectEl.style.display = "";
  const options = list.map((w) =>
    `<option value="${escapeHtml(w.id)}"${w.id === current ? " selected" : ""}>${escapeHtml(w.name)}${w.team ? ` · ${escapeHtml(w.team.name)}` : ""}</option>`).join("");
  if (selectEl.innerHTML !== options) selectEl.innerHTML = options;
  selectEl.value = current;
}

/* Load the shared token stylesheet once per document (views are mounted by
   the shell, which may or may not include theme.css itself). */
export function ensureTheme(doc = document) {
  if (doc.querySelector('link[data-oas-theme], style[data-oas-theme]')) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../theme.css", import.meta.url).href; // views/ → renderer/theme.css
  link.dataset.oasTheme = "1";
  doc.head.appendChild(link);
}

/* ── roster grouping: workspace → repo → instances, children indented under
   parents — ported verbatim from the panel. */
export function groupInstances(list) {
  const workspaces = new Map();
  for (const i of list) {
    const wsName = (i.workspace || "?").split("/").pop();
    if (!workspaces.has(wsName)) workspaces.set(wsName, new Map());
    const repos = workspaces.get(wsName);
    const rName = i.repoName || "?";
    if (!repos.has(rName)) repos.set(rName, []);
    repos.get(rName).push(i);
  }
  for (const repos of workspaces.values()) {
    for (const [rName, items] of repos) {
      const byName = new Map(items.map((i) => [i.instance, i]));
      const roots = items.filter((i) => !i.parentInstance || !byName.has(i.parentInstance));
      const kids = (p) => items.filter((i) => i.parentInstance === p.instance);
      const rank = (a, b) => (a.running === b.running ? a.instance.localeCompare(b.instance) : a.running ? -1 : 1);
      roots.sort(rank);
      const ordered = [];
      const walk = (i, depth) => { ordered.push({ ...i, depth }); kids(i).sort(rank).forEach((k) => walk(k, depth + 1)); };
      roots.forEach((r) => walk(r, 0));
      for (const i of items) if (!ordered.some((o) => o.instance === i.instance)) ordered.push({ ...i, depth: 0 });
      repos.set(rName, ordered);
    }
  }
  return workspaces;
}
