/* oas desktop — Spawn view: available agents (souls) per workspace, with
   spawn-from-app. Ports the panel's "Available agents" group: GET /api/agents,
   POST /api/spawn { agent, agentsRoot, task?, purpose? }. Panel defaults hold:
   task "" spawns an instance awaiting instructions; attached-mode agents are
   not spawnable standalone. Contract: mount(el, ctx) / unmount(). */
import {
  escapeHtml, apiJson, postJson, ensureTheme,
  setWorkspace, onWorkspaceChange, renderWorkspaceSelect, wsQuery,
} from "./common.mjs";

let state = null;

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = { el, ctx, souls: { agents: [] }, filterText: "", sel: null, timers: [], unsubWs: null, alive: true };
  el.innerHTML = `
    <div class="oas-view">
      <div class="side">
        <div class="filterbar">
          <select class="field wssel" style="display:none"></select>
        </div>
        <div class="filterbar" style="padding-top:0">
          <input class="field filter" placeholder="Filter agents…" autocomplete="off">
        </div>
        <div class="groups"><div class="loading-block"><span class="spinner"></span> Loading agents…</div></div>
      </div>
      <div class="detail">
        <div class="cards form" style="display:none">
          <div class="card">
            <h3>Spawn <span class="fname"></span></h3>
            <div class="body fdesc" style="color:var(--muted);margin-bottom:10px"></div>
            <div style="display:flex;flex-direction:column;gap:10px">
              <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Purpose (optional — becomes part of the instance name)
                <input class="field fpurpose" placeholder="e.g. pr42" autocomplete="off"></label>
              <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)">Task (optional — empty spawns an instance awaiting your instructions)
                <textarea class="field ftask" rows="6" placeholder="What should this instance do?"></textarea></label>
              <div style="display:flex;gap:8px;align-items:center">
                <button class="act fspawn">Spawn</button>
                <span class="fstatus" style="font-size:12.5px;color:var(--muted)"></span>
              </div>
            </div>
          </div>
        </div>
        <div class="empty placeholder"><span class="big">✦</span>Select an agent to spawn an instance.<br>Spawning with no task brings it up <b>awaiting instructions</b>.</div>
      </div>
    </div>`;
  s.q = (cls) => el.querySelector("." + cls);
  s.q("filter").addEventListener("input", (e) => { s.filterText = e.target.value; renderList(s); });
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.q("fspawn").onclick = () => doSpawn(s);
  s.unsubWs = onWorkspaceChange(() => { s.sel = null; showForm(s); refresh(s); });
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
  let souls, panel;
  try {
    [souls, panel] = await Promise.all([
      apiJson(s.ctx, `/api/agents${wsQuery()}`),
      apiJson(s.ctx, `/api/panel${wsQuery()}`),
    ]);
  } catch { return; } // keep the last good list
  if (!s.alive) return;
  s.souls = souls;
  renderWorkspaceSelect(s.q("wssel"), panel.workspaces, panel.workspace?.id || "");
  renderList(s);
}

function matches(s, a) {
  if (!s.filterText) return true;
  const t = s.filterText.toLowerCase();
  return [a.name, a.description, a.repoName].some((v) => String(v || "").toLowerCase().includes(t));
}

function renderList(s) {
  const el = s.q("groups");
  el.innerHTML = "";
  const list = s.souls.agents.filter((a) => matches(s, a));
  if (!s.souls.agents.length) { el.innerHTML = '<div class="empty"><span class="big">◎</span>No agents defined in this workspace.</div>'; return; }
  if (!list.length) { el.innerHTML = '<div class="empty">Nothing matches the filter.</div>'; return; }
  const h = document.createElement("div");
  h.className = "ghead";
  h.innerHTML = `Available agents <span class="count">${list.length}</span>`;
  el.appendChild(h);
  for (const a of list) {
    const attached = a.work === "attached"; // needs an owning instance's work tree
    const d = document.createElement("div");
    d.className = "inst" + (s.sel === a.name ? " sel" : "") + (attached ? " idle" : "");
    d.innerHTML = `
      <div class="iname">${escapeHtml(a.name)}</div>
      ${a.description ? `<div class="itask">${escapeHtml(a.description)}</div>` : ""}
      <div class="imeta">
        <span class="chip rt">${escapeHtml(a.runtime)}</span>
        <span class="chip">${escapeHtml(a.work)}</span>
        ${a.repo ? `<span class="chip">${escapeHtml(a.repoName)}</span>` : ""}
        ${a.kind === "tmp" ? '<span class="chip">local</span>' : ""}
        ${attached ? '<span class="chip">not spawnable standalone</span>' : ""}
      </div>`;
    d.title = attached
      ? "Attached-mode agent — needs an owning instance’s work tree; spawn from that instance"
      : "Select to spawn an instance";
    if (!attached) d.onclick = () => { s.sel = a.name; s.selAgent = a; renderList(s); showForm(s, a); };
    el.appendChild(d);
  }
}

function showForm(s, a) {
  const form = s.q("form"), ph = s.q("placeholder");
  if (!a) { form.style.display = "none"; ph.style.display = ""; return; }
  form.style.display = ""; ph.style.display = "none";
  s.q("fname").textContent = a.name;
  s.q("fdesc").textContent = a.description || "";
  s.q("fstatus").textContent = "";
  s.q("fspawn").disabled = false;
  s.q("fspawn").textContent = "Spawn";
}

async function doSpawn(s) {
  const a = s.selAgent;
  if (!a) return;
  const btn = s.q("fspawn"), status = s.q("fstatus");
  btn.disabled = true; btn.textContent = "Spawning…"; status.textContent = "";
  try {
    const d = await postJson(s.ctx, "/api/spawn", {
      agent: a.name,
      agentsRoot: a.agentsRoot,
      task: s.q("ftask").value,           // "" = awaiting instructions (panel default)
      purpose: s.q("fpurpose").value || undefined,
    });
    status.textContent = `Spawned ${d.instance}${d.launched ? " — session running" : ""}. Opening terminal…`;
    s.q("ftask").value = ""; s.q("fpurpose").value = "";
    s.ctx.openTerminal(d.instance);
  } catch (e) {
    status.textContent = `Spawn failed: ${e.message || e}`;
  } finally {
    btn.disabled = false; btn.textContent = "Spawn";
  }
}
