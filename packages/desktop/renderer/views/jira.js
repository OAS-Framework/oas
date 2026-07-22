/* oas desktop — Jira view: epic + Agent Roster panel per instance, from
   GET /api/jira/<instance> (feature-parity port of the oas-web jira endpoint;
   the browser panel exposed the API but this is its first full surface).
   Only instances whose oas.jira capability meta is present are listed.
   Contract: mount(el, ctx) / unmount(). Plain ES module + DOM. */
import {
  escapeHtml, apiJson, ensureTheme,
  setWorkspace, onWorkspaceChange, renderWorkspaceSelect, wsQuery,
} from "./common.js";

let state = null;

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = { el, ctx, panel: { instances: [] }, sel: null, req: 0, timers: [], unsubWs: null, alive: true };
  el.innerHTML = `
    <div class="oas-view">
      <div class="side">
        <div class="filterbar">
          <select class="field wssel" style="display:none"></select>
        </div>
        <div class="groups"><div class="loading-block"><span class="spinner"></span> Loading…</div></div>
      </div>
      <div class="detail">
        <div class="cards jbody">
          <div class="empty"><span class="big">◈</span>Select an instance with Jira meta to see its epic and Agent Roster.</div>
        </div>
      </div>
    </div>`;
  s.q = (cls) => el.querySelector("." + cls);
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.unsubWs = onWorkspaceChange(() => { s.sel = null; s.req++; refresh(s); });
  refresh(s);
  s.timers.push(setInterval(() => refresh(s), 8000));
}

export function unmount() {
  if (!state) return;
  state.alive = false;
  state.timers.forEach(clearInterval);
  if (state.unsubWs) state.unsubWs();
  state.el.innerHTML = "";
  state = null;
}

async function refresh(s) {
  let panel;
  try { panel = await apiJson(s.ctx, `/api/panel${wsQuery()}`); }
  catch { return; }
  if (!s.alive) return;
  s.panel = panel;
  renderWorkspaceSelect(s.q("wssel"), panel.workspaces, panel.workspace?.id || "");
  renderList(s);
}

function renderList(s) {
  const el = s.q("groups");
  el.innerHTML = "";
  const list = s.panel.instances.filter((i) => i.jira);
  if (!list.length) {
    el.innerHTML = '<div class="empty"><span class="big">◈</span>No instances with <code>oas.jira</code> meta in this workspace.</div>';
    return;
  }
  const h = document.createElement("div");
  h.className = "ghead";
  h.innerHTML = `Jira-linked instances <span class="count">${list.length}</span>`;
  el.appendChild(h);
  for (const i of list) {
    const d = document.createElement("div");
    d.className = "inst" + (s.sel === i.instance ? " sel" : "") + (i.running ? "" : " idle");
    d.innerHTML = `
      <div class="iname"><span class="dot ${i.running ? "on" : ""}"></span>${escapeHtml(i.instance)}</div>
      <div class="itask">${escapeHtml(i.jira.label || "")}</div>
      <div class="imeta">
        ${i.jira.project ? `<span class="chip">${escapeHtml(i.jira.project)}</span>` : ""}
        ${i.jira.site ? `<span class="chip">${escapeHtml(i.jira.site)}</span>` : ""}
      </div>`;
    d.onclick = () => select(s, i.instance);
    el.appendChild(d);
  }
}

async function select(s, name) {
  s.sel = name;
  renderList(s);
  const box = s.q("jbody");
  box.innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading Jira panel…</div>';
  const myReq = ++s.req;
  let d;
  try { d = await apiJson(s.ctx, `/api/jira/${encodeURIComponent(name)}`); }
  catch (e) {
    if (s.alive && myReq === s.req) box.innerHTML = `<div class="empty">Jira lookup failed: ${escapeHtml(e.message || String(e))}</div>`;
    return;
  }
  if (!s.alive || myReq !== s.req || s.sel !== name) return; // stale — never paint
  box.innerHTML = panelHtml(name, d);
}

export function panelHtml(name, d) {
  if (!d || !d.enabled) return `<div class="empty">No Jira meta on <code>${escapeHtml(name)}</code>.</div>`;
  if (d.error) return `<div class="card"><h3>Jira · ${escapeHtml(d.label || "")}</h3><div class="body">${escapeHtml(d.error)}</div></div>`;
  let html = "";
  if (d.epic) {
    html += `<div class="card"><h3>Epic</h3>
      <div class="body"><span class="jkey">${escapeHtml(d.epic.key)}</span> ${escapeHtml(d.epic.summary || "")}${d.epic.status ? ` <span class="chip">${escapeHtml(d.epic.status)}</span>` : ""}</div>`;
    if (Array.isArray(d.epic.roster) && d.epic.roster.length) {
      const cols = Object.keys(d.epic.roster[0]);
      html += `<h3 style="margin-top:12px">Agent Roster</h3>
        <table class="jt"><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>` +
        d.epic.roster.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c] || "")}</td>`).join("")}</tr>`).join("") +
        "</tbody></table>";
    }
    html += "</div>";
  }
  const tickets = Array.isArray(d.tickets) ? d.tickets : [];
  html += `<div class="card"><h3>Open tickets · ${escapeHtml(d.label || "")}${d.project ? ` · ${escapeHtml(d.project)}` : ""}</h3>`;
  html += tickets.length
    ? `<table class="jt"><thead><tr><th>Key</th><th>Type</th><th>Summary</th><th>Status</th><th>Parent</th></tr></thead><tbody>` +
      tickets.map((t) => `<tr><td class="jkey">${escapeHtml(t.key)}</td><td>${escapeHtml(t.type)}</td><td>${escapeHtml(t.summary)}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.parent || "")}</td></tr>`).join("") +
      "</tbody></table>"
    : '<div class="body">No open tickets with this label.</div>';
  html += "</div>";
  return html;
}
