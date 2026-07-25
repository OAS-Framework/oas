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
import { distinguishingRootTags } from "../instance-tree.mjs";

/** Required-version label for the disabled relation note — from the probe
 * payload when the backend provides it, else the pinned desktop default. */
function relationsMinLabel() { return cliStatus()?.relationsMin || "0.18.6"; }

/** True while the CLI probe has never SETTLED (no response classified yet).
 * Pending is card-less by design, so disabled buttons must explain
 * themselves — and the poll must keep retrying until a response lands. */
const cliProbePending = () => !cliStatus() && !cliKnownUnavailable();

const CSS = `
.souls { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }
.souls-bar { display: flex; align-items: center; gap: 10px; height: var(--bar-h, 48px); flex: none; padding: 0 14px;
             border-bottom: 1px solid var(--border); background: var(--surface); }
.souls-bar .filter { width: 260px; }
.souls-sum { color: var(--muted); font-size: 12.5px; }
.souls-grid { flex: 1; overflow-y: auto; padding: 18px; display: grid; gap: 14px;
              grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-content: start; }
.souls-grid .repo-head { grid-column: 1 / -1; color: var(--muted); font-size: 11px; font-weight: 650;
                         text-transform: uppercase; letter-spacing: .06em; padding: 4px 2px 0; }
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
.spawn-dialog fieldset.frelgroup { border: 1px solid var(--border); border-radius: 8px; margin: 0;
                                   padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.spawn-dialog fieldset.frelgroup legend { font-size: 12px; color: var(--muted); padding: 0 4px; }
.spawn-dialog .frelrow { display: flex; gap: 8px; align-items: center; }
.spawn-dialog .frelrow .frelation { flex: 0 1 auto; }
.spawn-dialog .frelrow .frelto { flex: 1 1 auto; min-width: 0; }
.spawn-dialog .freldesc { font-size: 12px; color: var(--muted); min-height: 0; }
.spawn-dialog .freldesc:empty { display: none; }
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
  s.unsubCli = onCliChange(() => {
    if (!s.alive) return;
    renderGrid(s);
    // an open modal tracks capability live — disabled state + version note
    // resync without touching typed fields (review 5526b70)
    s.syncModalRelations?.();
  });
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.unsubWs = onWorkspaceChange(() => {
    // Workspace switch owns the whole surface: invalidate any A spawn modal
    // immediately, remove its DOM before B loads, and clear A's agentsRoot.
    s.spawnOp++;
    closeSpawnModal(s, { repaint: false }); // the switch replaces the grid below
    s.q("souls-grid").innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading agents…</div>';
    // No force flag: if a newer B poll paints a B spawn modal before this
    // request resolves, the late switch refresh must respect that owner.
    refresh(s);
  });
  refresh(s);
  s.timers.push(setInterval(() => {
    refresh(s);
    // A boot-time transport failure leaves the CLI probe UNSETTLED (null
    // state, no card) — without a retry the Spawn buttons stay dead forever
    // with nothing on screen saying why. Keep re-fetching the cheap cached
    // state until a response settles it either way (ok / carded).
    if (cliProbePending()) refreshCli(ctx);
  }, 8000));
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
  // repaint:false — this very renderGrid call is already painting the grid;
  // a nested repaint from the close would render twice for nothing.
  if (noCli && s.sel) closeSpawnModal(s, { repaint: false });
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
  // Rendering-only repo grouping: cards sorted repo → name with a section
  // header per repo (agent family = the card itself). Data order untouched.
  const label = (a) => a.repoName || (a.repo ? String(a.repo).split("/").filter(Boolean).at(-1) : "") || "workspace";
  const sorted = [...list].sort((a, b) =>
    label(a).localeCompare(label(b)) || String(a.name).localeCompare(String(b.name)));
  let lastRepo = null;
  for (const a of sorted) {
    const repo = label(a);
    if (repo !== lastRepo) {
      lastRepo = repo;
      const rh = grid.ownerDocument.createElement("div");
      rh.className = "repo-head";
      rh.textContent = repo;
      grid.append(rh);
    }
    grid.append(soulCard(s, a));
  }
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
        // Pending probe renders NO card (frozen contract) — the tooltip must
        // not point at a card that is not there.
        ? (cliProbePending()
          ? "Checking for a compatible oas CLI — spawning enables once it is verified"
          : "Spawning requires a compatible installed oas CLI — see the card above")
        : `Spawn ${a.name}`;
    spawn.addEventListener("click", () => {
      if (!cliAvailable()) return; // state may have flipped since render
      openSpawnModal(s, a);
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
 * leaves the operation's status handling to the ownership tokens.
 * repaint (default true when a modal existed) re-renders the grid so the
 * card's .open highlight clears immediately — not on the next poll.
 * restoreFocus targets the CURRENTLY CONNECTED Spawn button of the agent
 * whose modal closed: renderGrid replaces nodes, so the captured opener is
 * usually detached by close time (review 41059e0) — the agent name is the
 * stable identity, matched via dataset (never a dynamic selector). */
function closeSpawnModal(s, { restoreFocus = false, repaint = true } = {}) {
  const hadModal = !!s.modalEl;
  const agentName = s.sel;
  s.sel = null; s.selAgent = null;
  s.modalEl?.remove(); s.modalEl = null;
  s.syncModalRelations = null;
  if (!hadModal || !repaint || s.alive === false) return;
  renderGrid(s); // clear the .open card highlight NOW
  if (!restoreFocus || !agentName) return;
  const button = [...(s.q("souls-grid").querySelectorAll?.("[data-agent]") || [])]
    .find((card) => card.dataset.agent === agentName)
    ?.querySelector(".spawn-act:not([disabled])");
  button?.focus();
}

/** Spawn modal (human change request on the integrated feature branch):
 * ALL spawn options in one dialog — purpose, task, and the agent-relation
 * options (relation + reference instance) directly visible, following the
 * app's ws-dialog pattern: role=dialog + aria-modal, labelled controls,
 * Tab focus trap, Esc/backdrop/× close, focus restored to the opener. */
function openSpawnModal(s, a) {
  closeSpawnModal(s); // one modal at a time; a new open supersedes the old
  s.sel = a.name; s.selAgent = a;
  renderGrid(s); // highlight the selected card under the backdrop

  const doc = s.el.ownerDocument;
  const modal = doc.createElement("div");
  modal.className = "spawn-modal";
  const titleId = "spawn-dialog-title";
  // Picker options carry BOTH halves of the anchor identity: the visible
  // value is the instance name (what the user reads), dataset.root is the
  // agents root it homes in — always sent as --relative-root so cross-root
  // name shadowing can never make the spawn ambiguous (kernel contract:
  // E_RELATIVE_AMBIGUOUS). Duplicate names get a SHORTEST-UNIQUE root tag
  // (naive one-segment tags collide: /a/project/agents vs /b/project/agents;
  // review cbd5bb3). Options are built with createElement/textContent/
  // dataset — roots are workspace paths and must never travel through
  // innerHTML attribute interpolation (injection surface; review cbd5bb3).
  const nameCounts = new Map();
  for (const i of s.panelInstances || []) nameCounts.set(i.instance, (nameCounts.get(i.instance) || 0) + 1);
  const dupRoots = (s.panelInstances || [])
    .filter((i) => (nameCounts.get(i.instance) || 0) > 1)
    .map((i) => i.agentsRoot);
  const rootTags = distinguishingRootTags(dupRoots);
  const buildRefOptions = (select) => {
    for (const i of s.panelInstances || []) {
      const opt = doc.createElement("option");
      opt.value = i.instance;
      opt.dataset.root = i.agentsRoot || "";
      const dup = (nameCounts.get(i.instance) || 0) > 1 && i.agentsRoot;
      const tag = dup ? ` [${rootTags.get(String(i.agentsRoot)) || i.agentsRoot}]` : "";
      opt.textContent = `${i.instance}${tag}${i.running ? "" : " (idle)"}`;
      select.append(opt);
    }
  };
  // ALL options are ALWAYS VISIBLE (human requirement): purpose, task,
  // relation + reference instance, runtime and model overrides. The CLI
  // capability gate never HIDES the relation controls — on a pre-relations
  // CLI the related choices (child/sibling/parent) and the reference picker
  // gate disabled with the required version named, while the select itself
  // and "unrelated" stay usable. The server still fails closed
  // (cli-no-relations) — render state is UX, not the
  // guard. Capability is NOT snapshotted: app focus re-probes the CLI, so
  // an open modal resyncs on every CLI change (review 5526b70) via
  // syncRelationControls below — typed fields are never touched.
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
        <fieldset class="frelgroup">
          <legend>Relation to other agents</legend>
          <div class="frelrow">
            <select class="field frelation" aria-label="Relation">
              <option value="unrelated" selected>Unrelated</option>
              <option value="child">Child of…</option>
              <option value="sibling">Sibling of…</option>
              <option value="parent">Parent of…</option>
            </select>
            <select class="field frelto" disabled aria-label="Which instance">
              <option value="">— which instance? —</option>
            </select>
          </div>
          <div class="freldesc" aria-live="polite"></div>
          <div class="frelnote" hidden></div>
        </fieldset>
        <label>Runtime (optional — defaults to the agent's definition: ${escapeHtml(a.runtime || "pi")})
          <select class="field fruntime">
            <option value="" selected>agent default (${escapeHtml(a.runtime || "pi")})</option>
            <option value="pi">pi</option>
            <option value="claude">claude</option>
          </select></label>
        <label>Model (optional — defaults to the agent's definition${a.model ? `: ${escapeHtml(a.model)}` : ""})
          <input class="field fmodel" autocomplete="off"></label>
        <div class="frow">
          <button class="act fspawn">Spawn</button>
          <button class="act fcancel">Cancel</button>
          <span class="fstatus" aria-live="polite"></span>
        </div>
      </div>
    </section>`;
  const dialog = modal.querySelector(".spawn-dialog");
  buildRefOptions(modal.querySelector(".frelto")); // safe DOM construction (never innerHTML)
  // SECURITY (merged-state review @3e76616): a.model is workspace-controlled
  // and escapeHtml is TEXT-context only (it does not escape quotes) — an
  // attribute interpolation lets `model: 'x" onpointerenter="...'` break out
  // and run with the privileged bridge. Assign the placeholder as a DOM
  // PROPERTY, never via innerHTML attribute text.
  modal.querySelector(".fmodel").placeholder = a.model || "runtime default";
  const f = modal; // field lookups span the whole modal

  // One source of truth for the relation controls' render state, applied at
  // open AND on every CLI change while the modal is open (review 5526b70):
  // capability can flip under an open dialog (app-focus re-probe after a
  // CLI up/downgrade). Only disabled/note state changes — typed and chosen
  // values are preserved (a selected relation stays visible after a
  // downgrade; an upgrade re-enables everything with values intact).
  // The SELECT itself stays enabled on an incapable CLI with only the
  // RELATED options disabled (review 8b26317): "unrelated" must remain a
  // reachable recovery so the typed task can still spawn on the old CLI.
  const syncRelationControls = () => {
    const relations = cliRelationsAvailable();
    const rel = f.querySelector(".frelation"), ref = f.querySelector(".frelto");
    const note = f.querySelector(".frelnote"), desc = f.querySelector(".freldesc");
    rel.disabled = false; // the select stays usable — gating is per-OPTION
    for (const opt of rel.querySelectorAll("option")) {
      if (opt.value !== "unrelated") opt.disabled = !relations;
    }
    const related = rel.value !== "unrelated";
    ref.disabled = !relations || !related;
    // one coherent choice: the picker's accessible name follows the chosen
    // relation ("Child of which instance?"), and a plain-language phrase
    // spells the outcome once both halves are picked
    ref.setAttribute("aria-label", related
      ? `${rel.value[0].toUpperCase()}${rel.value.slice(1)} of which instance?` : "Which instance");
    const phrase = { child: "child of", sibling: "sibling of", parent: "parent of" };
    // The outcome sentence must never promise what submit will reject
    // (review e9a9281): on a relations-incapable CLI the preserved related
    // choice renders, but the phrase yields to an unavailable-state message
    // consistent with the version note below it.
    desc.textContent = !related ? ""
      : !relations ? `Related spawn unavailable on the installed CLI — this would be a ${phrase[rel.value]} ${ref.value || "…"}.`
      : ref.value ? `This instance will spawn as a ${phrase[rel.value]} ${ref.value}.`
      : `Pick the instance this one is a ${phrase[rel.value]}.`;
    note.hidden = relations;
    note.textContent = relations ? "" : `Relations require oas >= ${relationsMinLabel()} — the installed CLI spawns unrelated instances only. Set the relation to "Unrelated" to spawn now.`;
  };
  s.syncModalRelations = syncRelationControls;
  syncRelationControls();

  // both halves of the grouped choice re-derive the state and phrase
  f.querySelector(".frelto").addEventListener("change", syncRelationControls);

  // reference picker enables only when a real relation is chosen — kept
  // VISIBLE (disabled) so the hierarchy options are always in sight
  f.querySelector(".frelation").addEventListener("change", syncRelationControls);

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
    relativeRoot: () => f.querySelector(".frelto").selectedOptions?.[0]?.dataset?.root || "",
    runtime: () => f.querySelector(".fruntime").value,
    model: () => f.querySelector(".fmodel").value,
    clear: () => {
      f.querySelector(".fpurpose").value = ""; f.querySelector(".ftask").value = "";
      f.querySelector(".frelation").value = "unrelated";
      f.querySelector(".frelto").value = "";
      syncRelationControls(); // re-disable the picker for "unrelated"
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
export async function waitForInstanceInPanel(s, ref, isCurrent, { tries = 20, delayMs = 700, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  // ref: { instance, home?, agentsRoot? }. Match the COMPOSITE identity when
  // the spawn result provides it — with a same-named twin already in the
  // roster, a bare-name wait would succeed early and the follow-up open then
  // refuse the ambiguous name (merged-state review @7dd1e7b).
  const matches = (x) => x.instance === ref.instance
    && (!ref.home || !x.home || x.home === ref.home)
    && (!ref.agentsRoot || !x.agentsRoot || x.agentsRoot === ref.agentsRoot);
  for (let i = 0; i < tries; i++) {
    if (!isCurrent()) return false;          // ws switched / superseded: stop
    try {
      const panel = await apiJson(s.ctx, `/api/panel${wsQuery()}`);
      if (!isCurrent()) return false;
      if ((panel.instances || []).some(matches)) return true;
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
    closeSpawnModal(s); // also repaints the degradation card + disabled buttons
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
  const relation = ui.relation ? String(ui.relation() || "unrelated") : "unrelated";
  const relativeTo = ui.relativeTo ? String(ui.relativeTo() || "") : "";
  // Submit-time capability guard FIRST (reviews f35c1dc + 8b26317): a
  // downgrade while the modal was open preserves the chosen relation, and
  // doSpawn reads values programmatically — without this check the retained
  // related spawn would dispatch into the server's cli-no-relations
  // rejection. Capability precedes pairing so a no-reference downgrade
  // never advises picking a DISABLED reference. Recovery is real: the
  // relation select keeps "unrelated" enabled (related options disabled),
  // so the typed task can still spawn on the old CLI.
  if (relation !== "unrelated" && !cliRelationsAvailable()) {
    ui.status.classList?.add("err");
    ui.status.textContent = `Spawn failed: the installed oas CLI cannot spawn related instances — set the relation to "unrelated" to spawn now, or upgrade the CLI.`;
    return;
  }
  // Relation pairing is validated BEFORE dispatch: a chosen relation needs a
  // reference instance (the server would 409 anyway — fail it in the form).
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
      // anchor root: ALWAYS sent with a related spawn when the picker knows
      // it — disambiguates cross-root name shadowing (E_RELATIVE_AMBIGUOUS)
      relativeRoot: relation !== "unrelated" ? ((ui.relativeRoot ? ui.relativeRoot() : "") || undefined) : undefined,
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
    // Poll and open by COMPOSITE identity — the spawn result's home plus the
    // selected agent's root disambiguate a same-named twin (review @7dd1e7b).
    const spawnedRef = { instance: d.instance, ...(d.home ? { home: d.home } : {}), ...(a.agentsRoot ? { agentsRoot: a.agentsRoot } : {}) };
    const visible = await waitForInstanceInPanel(s, spawnedRef, current, s.waitOpts);
    if (!current()) return;
    if (!visible) { ui.status.textContent = `Spawned ${d.instance} — roster is catching up; open it from the sidebar instance roster.`; return; }
    ui.status.textContent = `Spawned ${d.instance}${d.launched ? " — session running" : ""}. Opening terminal…`;
    s.ctx.openTerminal(spawnedRef);
  } catch (e) {
    if (owns()) {
      ui.status.classList?.add("err");
      // Ambiguous relation identity (kernel E_RELATIVE_AMBIGUOUS). The
      // picker ALWAYS sends the anchor's root, so this rarely means "pick
      // better": the kernel also fires it when an already-qualified target
      // cannot round-trip under shadowing, when a parent relation's
      // generated name is shadowed, and on INHERITED bare-name edges copied
      // from the anchor (case d) — names this form never sent. The kernel
      // message names the conflicting instance and homes: surface it
      // verbatim with the general remedy (reviews cbd5bb3 + f1e3211).
      ui.status.textContent = e.code === "E_RELATIVE_AMBIGUOUS"
        ? `Spawn failed: ${e.message} — instance names collide across agent roots; rename or retire the shadowing instance (or pick a different purpose) and retry.`
        : `Spawn failed: ${e.message || e}`;
    }
  } finally {
    if (owns()) { ui.btn.disabled = false; ui.btn.textContent = "Spawn"; }
  }
}
