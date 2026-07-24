/* oas desktop — Spawn view: the souls browser.
   Browse available agents (souls) per workspace as a card grid — description
   and capability chips up front — and spawn from the card: selecting one
   flips it into an inline spawn form (purpose + task). Panel defaults hold:
   task "" spawns an instance awaiting instructions; attached-mode agents are
   not spawnable standalone. GET /api/agents, POST /api/spawn.
   Contract: mount(el, ctx) / unmount(). Plain ES module + DOM. */
import {
  escapeHtml, apiJson, postJson, ensureTheme,
  setWorkspace, onWorkspaceChange, renderWorkspaceSelect, wsQuery, workspaceGeneration,
} from "./common.mjs";

const CSS = `
.souls { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
.souls-bar { display: flex; align-items: center; gap: 10px; height: var(--bar-h, 48px); flex: none; padding: 0 14px;
             border-bottom: 1px solid var(--border); background: var(--surface); }
.souls-bar .filter { width: 260px; }
.souls-sum { color: var(--muted); font-size: 12.5px; }
.souls-grid { flex: 1; overflow-y: auto; padding: 18px; display: grid; gap: 14px;
              grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-content: start; }
.soul-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
             padding: 14px 16px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 8px;
             text-align: left; font: inherit; color: var(--fg); }
.soul-card:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.soul-card.attached { border-style: dashed; background: var(--surface-2); }
.soul-card.open { border-color: var(--accent); background: var(--sel); }
.soul-card .sname { font-weight: 650; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.soul-card .sname .glyph { color: var(--accent); }
.soul-card .sdesc { color: var(--muted); font-size: 12.5px; line-height: 1.5; flex: 1; }
.soul-card .schips { display: flex; gap: 5px; flex-wrap: wrap; }
.soul-card .sactions { display: flex; gap: 7px; margin-top: 3px; }
.soul-card .sactions .act { padding: 5px 11px; }
.soul-card .sactions .brain-act { color: var(--accent); }
.soul-form { display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
.soul-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.soul-form .frow { display: flex; gap: 8px; align-items: center; }
.soul-form .fstatus { font-size: 12.5px; color: var(--muted); }
.soul-form .fstatus.err { color: var(--danger); }
`;

let state = null;

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = { el, ctx, souls: { agents: [] }, filterText: "", sel: null, timers: [], unsubWs: null, alive: true, spawnOp: 0 };
  el.innerHTML = `
    <div class="oas-view" style="display:block">
      <style>${CSS}</style>
      <div class="souls">
        <div class="souls-bar">
          <select class="field wssel" style="display:none"></select>
          <input class="field filter" placeholder="Filter agents…" autocomplete="off">
          <span class="souls-sum"></span>
        </div>
        <div class="souls-grid"><div class="loading-block"><span class="spinner"></span> Loading agents…</div></div>
      </div>
    </div>`;
  s.q = (cls) => el.querySelector("." + cls);
  s.q("filter").addEventListener("input", (e) => { s.filterText = e.target.value; renderGrid(s); });
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.unsubWs = onWorkspaceChange(() => {
    // Workspace switch owns the whole surface: invalidate any A spawn form
    // immediately, remove its DOM before B loads, and clear A's agentsRoot.
    s.spawnOp++;
    s.sel = null;
    s.selAgent = null;
    s.q("souls-grid").innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading agents…</div>';
    // No force flag: if a newer B poll paints a B spawn form before this
    // request resolves, the late switch refresh must respect that owner.
    refresh(s);
  });
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

/* Exported for the deferred cross-workspace regression. */
export async function refresh(s) {
  const myGen = workspaceGeneration();       // capture at dispatch
  let souls, panel;
  try {
    [souls, panel] = await Promise.all([
      apiJson(s.ctx, `/api/agents${wsQuery()}`),
      apiJson(s.ctx, `/api/panel${wsQuery()}`),
    ]);
  } catch { return; } // keep the last good list
  // discard deferred responses from a previous workspace — they'd paint A's
  // agent list over B's after a switch
  if (!s.alive || myGen !== workspaceGeneration()) return;
  s.souls = souls;
  renderWorkspaceSelect(s.q("wssel"), panel.workspaces, panel.workspace?.id || "");
  renderGrid(s);
}

function matches(s, a) {
  if (!s.filterText) return true;
  const t = s.filterText.toLowerCase();
  return [a.name, a.description, a.repoName].some((v) => String(v || "").toLowerCase().includes(t));
}

function renderGrid(s) {
  const grid = s.q("souls-grid");
  // Polling (including a delayed switch-triggered refresh) must never replace
  // a newer form that owns an in-flight mutation. Workspace switching already
  // removes A synchronously before dispatching B's refresh.
  if (grid.querySelector?.(".soul-form button:disabled")) return;
  grid.innerHTML = "";
  const list = s.souls.agents.filter((a) => matches(s, a));
  const spawnable = s.souls.agents.filter((a) => a.work !== "attached").length;
  s.q("souls-sum").textContent = s.souls.agents.length
    ? `${s.souls.agents.length} agents · ${spawnable} spawnable` : "";
  if (!s.souls.agents.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><span class="big">◎</span>No agents defined in this workspace.</div>';
    return;
  }
  if (!list.length) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Nothing matches the filter.</div>'; return; }
  if (typeof grid.append !== "function") return; // non-DOM host (tests observe s.souls)
  for (const a of list) grid.append(soulCard(s, a));
}

function soulCard(s, a) {
  const attached = a.work === "attached"; // needs an owning instance's work tree
  const open = s.sel === a.name && !attached;
  const card = document.createElement("div");
  card.className = "soul-card" + (attached ? " attached" : "") + (open ? " open" : "");
  card.innerHTML = `
    <div class="sname"><span class="glyph" aria-hidden="true">✦</span>${escapeHtml(a.name)}</div>
    ${a.description ? `<div class="sdesc">${escapeHtml(a.description)}</div>` : '<div class="sdesc"></div>'}
    <div class="schips">
      <span class="chip rt">${escapeHtml(a.runtime)}</span>
      <span class="chip">${escapeHtml(a.work)}</span>
      ${a.repo ? `<span class="chip">${escapeHtml(a.repoName)}</span>` : ""}
      ${a.kind === "tmp" ? '<span class="chip">local</span>' : ""}
      ${attached ? '<span class="chip">not spawnable standalone</span>' : ""}
    </div>`;
  const actions = document.createElement("div");
  actions.className = "sactions";
  if (!open) {
    const spawn = document.createElement("button");
    spawn.className = "act spawn-act";
    spawn.textContent = attached ? "Attached only" : "Spawn";
    spawn.disabled = attached;
    spawn.title = attached
      ? "Attached-mode agent — spawn it from an owning instance’s work tree"
      : `Spawn ${a.name}`;
    spawn.addEventListener("click", () => {
      s.sel = a.name; s.selAgent = a; renderGrid(s);
      s.q("souls-grid").querySelector(".soul-form .fpurpose")?.focus();
    });
    actions.append(spawn);
  }
  const brain = document.createElement("button");
  brain.className = "act brain-act";
  brain.textContent = "View brain";
  brain.disabled = typeof s.ctx.openBrain !== "function";
  brain.addEventListener("click", () => s.ctx.openBrain?.(a.name));
  actions.append(brain);
  card.append(actions);
  if (open) card.append(spawnForm(s, a));
  return card;
}

function spawnForm(s, a) {
  const f = document.createElement("div");
  f.className = "soul-form";
  f.innerHTML = `
    <label>Purpose (optional — becomes part of the instance name)
      <input class="field fpurpose" placeholder="e.g. pr42" autocomplete="off"></label>
    <label>Task (optional — empty spawns an instance awaiting your instructions)
      <textarea class="field ftask" rows="4" placeholder="What should this instance do?"></textarea></label>
    <div class="frow">
      <button class="act fspawn">Spawn</button>
      <button class="act fcancel">Cancel</button>
      <span class="fstatus"></span>
    </div>`;
  f.addEventListener("click", (e) => e.stopPropagation()); // clicks in the form never re-select the card
  f.querySelector(".fcancel").addEventListener("click", () => { s.sel = null; renderGrid(s); });
  f.querySelector(".fspawn").addEventListener("click", () => doSpawn(s, {
    btn: f.querySelector(".fspawn"),
    status: f.querySelector(".fstatus"),
    purpose: () => f.querySelector(".fpurpose").value,
    task: () => f.querySelector(".ftask").value,
    clear: () => { f.querySelector(".fpurpose").value = ""; f.querySelector(".ftask").value = ""; },
  }));
  return f;
}

/* Exported for the in-flight-spawn regressions.

   Two invalidation tokens gate ALL post-await mutation:
   - workspace generation: a spawn begun in workspace A that completes after a
     switch to B must NOT auto-open the terminal (openTerminal resolves names
     in the CURRENT workspace — a same-named B instance would receive input
     meant for the new A one);
   - a per-spawn operation token (s.spawnOp): the form is per-card but shared
     against re-renders — after a switch the user may already be spawning
     another agent, and a late completion must not touch a form it no longer
     owns. Only the currently active operation may mutate UI — success,
     error, and finally paths alike. */
/* After a spawn, the roster SNAPSHOT lags: /api/panel is refreshed by a
   background collector only every ~3s, so the new instance is usually not
   in it yet — and the shell's openTerminal resolves instances from that
   same endpoint, so opening immediately yields "unknown instance". Poll the
   selected workspace's panel until the instance appears (ownership- and
   generation-gated), then hand off. Exported for the stale-snapshot
   regression. delayMs is injectable so tests run without real waits. */
export async function waitForInstanceInPanel(s, name, isCurrent, { tries = 20, delayMs = 700, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  for (let i = 0; i < tries; i++) {
    if (!isCurrent()) return false;          // ws switched / superseded: stop
    try {
      const panel = await apiJson(s.ctx, `/api/panel${wsQuery()}`);
      if (!isCurrent()) return false;
      if ((panel.instances || []).some((x) => x.instance === name)) return true;
    } catch { /* transient — keep polling */ }
    await wait(delayMs);
  }
  return false;                              // snapshot never caught up: no auto-open
}

export async function doSpawn(s, ui) {
  const a = s.selAgent;
  if (!a) return;
  // Legacy field interface (shared regression tests + old callers): adapt
  // s.q("ftask"|"fpurpose"|"fspawn"|"fstatus") into the ui seam.
  if (!ui) {
    const btn = s.q("fspawn"), status = s.q("fstatus");
    const taskEl = s.q("ftask"), purposeEl = s.q("fpurpose");
    ui = {
      btn, status,
      task: () => taskEl.value,
      purpose: () => purposeEl.value,
      clear: () => { taskEl.value = ""; purposeEl.value = ""; },
    };
  }
  const myGen = workspaceGeneration();       // capture at dispatch
  const myOp = ++s.spawnOp;                  // this spawn owns the form until superseded
  const owns = () => myOp === s.spawnOp && s.alive !== false;
  ui.btn.disabled = true; ui.btn.textContent = "Spawning…";
  ui.status.classList?.remove("err"); ui.status.textContent = "";
  try {
    const d = await postJson(s.ctx, "/api/spawn", {
      agent: a.name,
      agentsRoot: a.agentsRoot,
      task: ui.task(),                       // "" = awaiting instructions (panel default)
      purpose: ui.purpose() || undefined,
    });
    if (myGen !== workspaceGeneration()) {
      // Workspace switched while the spawn was in flight: never auto-open.
      if (owns()) ui.status.textContent = `Spawned ${d.instance} in the previous workspace — switch back to open its terminal.`;
      return;
    }
    if (!owns()) return;                     // superseded — leave the form alone
    ui.clear();
    ui.status.textContent = `Spawned ${d.instance}${d.launched ? " — session running" : ""}. Waiting for the roster…`;
    // The panel snapshot lags spawns by up to a collector cycle; opening the
    // terminal before the instance is in /api/panel makes the shell resolve
    // "unknown instance". Wait for it, still gated by ownership + workspace.
    const current = () => owns() && myGen === workspaceGeneration();
    const visible = await waitForInstanceInPanel(s, d.instance, current, s.waitOpts);
    if (!current()) return;
    if (!visible) { ui.status.textContent = `Spawned ${d.instance} — roster is catching up; open it from the Instances view.`; return; }
    ui.status.textContent = `Spawned ${d.instance}${d.launched ? " — session running" : ""}. Opening terminal…`;
    s.ctx.openTerminal(d.instance);
  } catch (e) {
    if (owns()) { ui.status.classList?.add("err"); ui.status.textContent = `Spawn failed: ${e.message || e}`; }
  } finally {
    if (owns()) { ui.btn.disabled = false; ui.btn.textContent = "Spawn"; }
  }
}
