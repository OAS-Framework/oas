/* oas desktop — Spawn view: the souls browser.
   Browse available agents (souls) per workspace as a card grid — description
   and capability chips up front — and spawn from the card: "Spawn" opens a
   MODAL dialog with every spawn option (purpose, task, relation + reference
   instance) directly visible. Panel defaults hold: task "" spawns an
   instance awaiting instructions; attached-mode agents are not spawnable
   standalone. GET /api/agents, POST /api/spawn.
   Contract: mount(el, ctx) / unmount(). Plain ES module + DOM. */
import {
  escapeHtml, apiJson, postJson, ensureTheme,
  setWorkspace, onWorkspaceChange, renderWorkspaceSelect, wsQuery, workspaceGeneration,
} from "./common.mjs";
import { cliAvailable, cliKnownUnavailable, cliStatus, refreshCli, onCliChange, cliCard, cliRelationsAvailable } from "./cli-status.mjs";

/** Required-version label for the disabled relation note — from the probe
 * payload when the backend provides it, else the pinned desktop default. */
function relationsMinLabel() { return cliStatus()?.relationsMin || "0.18.3"; }

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
.spawn-modal { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 24px;
               background: color-mix(in srgb, var(--bg) 60%, transparent); }
.spawn-dialog { width: min(520px, 100%); max-height: min(680px, calc(100vh - 48px)); display: flex;
                flex-direction: column; gap: 10px; overflow-y: auto; background: var(--surface);
                border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
                padding: 16px 18px; }
.spawn-dialog-head { display: flex; align-items: flex-start; gap: 8px; }
.spawn-dialog-head h2 { margin: 0; font-size: 16px; line-height: 1.3; flex: 1; }
.spawn-dialog-head .sdesc { color: var(--muted); font-size: 12.5px; }
.spawn-dialog .close-act { margin-left: auto; width: 28px; height: 28px; border: 0; border-radius: 6px;
                           background: none; color: var(--muted); font-size: 16px; cursor: pointer; }
.spawn-dialog .close-act:hover { background: var(--surface-2); color: var(--fg); }
.spawn-dialog .frelnote { font-size: 12px; color: var(--muted); }
`;

let state = null;

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = { el, ctx, souls: { agents: [] }, panelInstances: [], filterText: "", sel: null, timers: [], unsubWs: null, alive: true, spawnOp: 0 };
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
  // CLI degradation: refresh once on mount and re-render the grid whenever
  // availability flips — spawn buttons disable consistently with the card.
  refreshCli(ctx);
  s.unsubCli = onCliChange(() => { if (s.alive) renderGrid(s); });
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.unsubWs = onWorkspaceChange(() => {
    // Workspace switch owns the whole surface: invalidate any A spawn modal
    // immediately, remove its DOM before B loads, and clear A's agentsRoot.
    s.spawnOp++;
    closeSpawnModal(s);
    s.q("souls-grid").innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading agents…</div>';
    // No force flag: if a newer B poll paints a B spawn modal before this
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
  if (state.unsubCli) state.unsubCli();
  if (state.cliCardHandle) { state.cliCardHandle.dispose(); state.cliCardHandle = null; }
  closeSpawnModal(state);
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
  s.panelInstances = panel.instances || []; // reference-instance picker source
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
  // The spawn form lives in a MODAL outside the grid (human change request on
  // the integrated feature branch), so periodic polls may rebuild the roster
  // freely without wiping typed-but-unsubmitted task/purpose text — the
  // modal DOM is untouched by grid repaints. The one transition that must
  // still reach INTO the modal is CLI degradation (review d7becaf): a modal
  // opened while the CLI state was unknown must not leave a live submit
  // behind a missing degradation card when the probe lands ok:false. Close
  // it; the rebuild shows the card and disabled buttons; doSpawn
  // independently re-checks at submit time.
  const noCli = !cliAvailable(); // frozen contract: unknown does NOT render capable
  if (noCli && s.sel) closeSpawnModal(s);
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
  // One consistent degradation card ABOVE the roster when the CLI is KNOWN
  // unavailable — reads (the soul cards, brain) stay fully usable below it.
  // Unknown state (pre-probe) disables buttons WITHOUT the card: mutations
  // require a verified compatible CLI (frozen contract), but flashing the
  // card during the milliseconds before the launch probe resolves would be
  // noise.
  if (state && s === state && cliKnownUnavailable()) {
    if (s.cliCardHandle) s.cliCardHandle.dispose();
    s.cliCardHandle = cliCard(grid.ownerDocument, s.ctx);
    s.cliCardHandle.el.style.gridColumn = "1/-1";
    grid.append(s.cliCardHandle.el);
  } else if (s.cliCardHandle) { s.cliCardHandle.dispose(); s.cliCardHandle = null; }
  for (const a of list) grid.append(soulCard(s, a));
}

function soulCard(s, a) {
  const attached = a.work === "attached"; // needs an owning instance's work tree
  const noCli = !cliAvailable();          // unknown OR unavailable — mutations need a verified CLI
  const card = document.createElement("div");
  card.className = "soul-card" + (attached ? " attached" : "") + (s.sel === a.name ? " open" : "");
  card.dataset.agent = a.name;
  card.innerHTML = `
    <div class="sname"><span class="glyph" aria-hidden="true">✦</span>${escapeHtml(a.name)}</div>
    ${a.description ? `<div class="sdesc">${escapeHtml(a.description)}</div>` : '<div class="sdesc"></div>'}
    <div class="schips">
      <span class="chip rt">${escapeHtml(a.runtime)}</span>
      <span class="chip">${escapeHtml(a.work)}</span>
      ${a.repo ? `<span class="chip">${escapeHtml(a.repoName)}</span>` : ""}
      ${a.kind === "local" ? '<span class="chip">local</span>' : ""}
      ${attached ? '<span class="chip">not spawnable standalone</span>' : ""}
    </div>`;
  const actions = document.createElement("div");
  actions.className = "sactions";
  {
    const spawn = document.createElement("button");
    spawn.className = "act spawn-act";
    spawn.textContent = attached ? "Attached only" : "Spawn";
    spawn.disabled = attached || noCli;
    spawn.title = attached
      ? "Attached-mode agent — spawn it from an owning instance’s work tree"
      : noCli
        ? "Spawning requires a compatible installed oas CLI — see the card above"
        : `Spawn ${a.name}`;
    spawn.addEventListener("click", () => {
      if (!cliAvailable()) return; // state may have flipped since render
      openSpawnModal(s, a, spawn);
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
  return card;
}

/** Close (if open) the spawn modal and clear the selection. Safe to call
 * when no modal exists. Does NOT bump spawnOp — callers that must invalidate
 * an in-flight spawn (workspace switch) bump it themselves; a plain close
 * leaves the operation's status handling to the ownership tokens. */
function closeSpawnModal(s, { restoreFocus = false } = {}) {
  const opener = s.modalOpener;
  s.sel = null; s.selAgent = null; s.modalOpener = null;
  s.modalEl?.remove(); s.modalEl = null;
  if (restoreFocus && opener?.isConnected) opener.focus();
}

/** Spawn modal (human change request on the integrated feature branch):
 * ALL spawn options in one dialog — purpose, task, and the agent-relation
 * options (relation + reference instance) directly visible, following the
 * app's ws-dialog pattern: role=dialog + aria-modal, labelled controls,
 * Tab focus trap, Esc/backdrop/× close, focus restored to the opener. */
function openSpawnModal(s, a, opener) {
  closeSpawnModal(s); // one modal at a time; a new open supersedes the old
  s.sel = a.name; s.selAgent = a; s.modalOpener = opener || null;
  renderGrid(s); // highlight the selected card under the backdrop

  const doc = s.el.ownerDocument;
  const modal = doc.createElement("div");
  modal.className = "spawn-modal";
  const titleId = "spawn-dialog-title";
  const refOptions = (s.panelInstances || [])
    .map((i) => `<option value="${escapeHtml(i.instance)}">${escapeHtml(i.instance)}${i.running ? "" : " (idle)"}</option>`)
    .join("");
  // ALL options are ALWAYS VISIBLE (human requirement): purpose, task,
  // relation + reference instance, runtime and model overrides. The CLI
  // capability gate never HIDES the relation controls — on a pre-relations
  // CLI they render disabled with the required version named. The server
  // still fails closed (cli-no-relations) — render state is UX, not the
  // guard.
  const relations = cliRelationsAvailable();
  modal.innerHTML = `
    <section class="spawn-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="spawn-dialog-head">
        <div>
          <h2 id="${titleId}">Spawn ${escapeHtml(a.name)}</h2>
          ${a.description ? `<div class="sdesc">${escapeHtml(a.description)}</div>` : ""}
          <div class="schips" style="margin-top:6px">
            <span class="chip">${escapeHtml(a.work)}</span>
            ${a.repo ? `<span class="chip">${escapeHtml(a.repoName)}</span>` : ""}
          </div>
        </div>
        <button class="close-act fcancel-x" type="button" aria-label="Close spawn dialog">×</button>
      </div>
      <div class="soul-form">
        <label>Purpose (optional — becomes part of the instance name)
          <input class="field fpurpose" placeholder="e.g. pr42" autocomplete="off"></label>
        <label>Task (optional — empty spawns an instance awaiting your instructions)
          <textarea class="field ftask" rows="4" placeholder="What should this instance do?"></textarea></label>
        <label>Relation — how this instance links into the agent hierarchy
          <select class="field frelation" ${relations ? "" : "disabled"}>
            <option value="unrelated" selected>unrelated — no link</option>
            <option value="child">child — nests under the reference instance</option>
            <option value="sibling">sibling — peer in the reference instance's cluster</option>
            <option value="parent">parent — becomes the reference instance's parent</option>
          </select></label>
        <label class="frelto-label">Reference instance
          <select class="field frelto" disabled>
            <option value="">— select an instance —</option>
            ${refOptions}
          </select></label>
        ${relations ? "" : `<div class="frelnote">Relations require oas &gt;= ${escapeHtml(relationsMinLabel())} — the installed CLI spawns unrelated instances only.</div>`}
        <label>Runtime (optional — defaults to the agent's definition: ${escapeHtml(a.runtime || "pi")})
          <select class="field fruntime">
            <option value="" selected>agent default (${escapeHtml(a.runtime || "pi")})</option>
            <option value="pi">pi</option>
            <option value="claude">claude</option>
          </select></label>
        <label>Model (optional — defaults to the agent's definition${a.model ? `: ${escapeHtml(a.model)}` : ""})
          <input class="field fmodel" placeholder="${escapeHtml(a.model || "runtime default")}" autocomplete="off"></label>
        <div class="frow">
          <button class="act fspawn">Spawn</button>
          <button class="act fcancel">Cancel</button>
          <span class="fstatus" aria-live="polite"></span>
        </div>
      </div>
    </section>`;
  const dialog = modal.querySelector(".spawn-dialog");
  const f = modal; // field lookups span the whole modal

  // reference picker enables only when a real relation is chosen — kept
  // VISIBLE (disabled) so the hierarchy options are always in sight
  f.querySelector(".frelation").addEventListener("change", (e) => {
    f.querySelector(".frelto").disabled = !relations || e.target.value === "unrelated";
  });

  const close = () => closeSpawnModal(s, { restoreFocus: true });
  f.querySelector(".fcancel").addEventListener("click", close);
  f.querySelector(".fcancel-x").addEventListener("click", close);
  modal.addEventListener("mousedown", (e) => { if (e.target === modal) close(); }); // backdrop
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return; // focus trap (ws-dialog pattern)
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])")]
      .filter((el) => !el.hidden && el.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  f.querySelector(".fspawn").addEventListener("click", () => doSpawn(s, {
    btn: f.querySelector(".fspawn"),
    status: f.querySelector(".fstatus"),
    purpose: () => f.querySelector(".fpurpose").value,
    task: () => f.querySelector(".ftask").value,
    relation: () => f.querySelector(".frelation").value,
    relativeTo: () => f.querySelector(".frelto").value,
    runtime: () => f.querySelector(".fruntime").value,
    model: () => f.querySelector(".fmodel").value,
    clear: () => {
      f.querySelector(".fpurpose").value = ""; f.querySelector(".ftask").value = "";
      f.querySelector(".frelation").value = "unrelated";
      f.querySelector(".frelto").value = "";
      f.querySelector(".frelto").disabled = true;
      f.querySelector(".fruntime").value = "";
      f.querySelector(".fmodel").value = "";
    },
  }));

  s.modalEl = modal;
  s.el.querySelector(".souls").append(modal);
  f.querySelector(".fpurpose").focus?.();
  return modal;
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
  // CLI gate at SUBMIT time (review d7becaf): a modal opened before a state
  // flip must not dispatch — the render-time disable alone cannot cover a
  // dialog that was already open. Mutations require a VERIFIED compatible CLI.
  if (!cliAvailable()) {
    closeSpawnModal(s);
    renderGrid(s); // repaints the degradation card + disabled buttons
    return;
  }
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
  // Relation pairing is validated BEFORE dispatch: a chosen relation needs a
  // reference instance (the server would 409 anyway — fail it in the form).
  const relation = ui.relation ? String(ui.relation() || "unrelated") : "unrelated";
  const relativeTo = ui.relativeTo ? String(ui.relativeTo() || "") : "";
  if (relation !== "unrelated" && !relativeTo) {
    ui.status.classList?.add("err");
    ui.status.textContent = `Spawn failed: the "${relation}" relation needs a reference instance.`;
    return;
  }
  ui.btn.disabled = true; ui.btn.textContent = "Spawning…";
  ui.status.classList?.remove("err"); ui.status.textContent = "";
  try {
    const d = await postJson(s.ctx, "/api/spawn", {
      agent: a.name,
      agentsRoot: a.agentsRoot,
      task: ui.task(),                       // "" = awaiting instructions (panel default)
      purpose: ui.purpose() || undefined,
      relation: relation !== "unrelated" ? relation : undefined,
      relativeTo: relation !== "unrelated" ? relativeTo : undefined,
      runtime: (ui.runtime ? ui.runtime() : "") || undefined,
      model: (ui.model ? ui.model() : "") || undefined,
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
