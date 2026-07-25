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
import { registerAction } from "../keybindings.mjs";
import { resolveViewKey } from "../view-keys.mjs";
import { cliAvailable, cliKnownUnavailable, cliStatus, refreshCli, onCliChange, cliCard } from "./cli-status.mjs";

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
  // Keyboard operability (task: keybindings wiring): `/` focuses the filter,
  // arrows rove the card grid, Enter opens the focused card's spawn form,
  // b opens its brain, Esc cancels an open form. spawn.filter/spawn.brain
  // are registered stage:spawn actions; their keys resolve through the
  // engine keymap (view-keys.mjs) so editor rebinds take effect, while
  // dispatch stays view-local and editable-guarded.
  s.q("souls-grid").addEventListener("keydown", (e) => onGridKey(s, e));
  s.viewActions = [
    { id: "spawn.filter", defaultChord: "/", run: () => s.q("filter").focus() },
    { id: "spawn.brain", defaultChord: "B", run: () => brainOfFocusedCard(s) },
  ];
  el.querySelector(".souls").addEventListener("keydown", (e) => {
    // Esc cancels the open spawn form from anywhere inside it (incl. the
    // task textarea — cancel is safe; submit stays click/button-only there).
    if (e.key === "Escape" && s.sel) { e.preventDefault(); s.sel = null; s.selAgent = null; renderGrid(s); return; }
    // view-local keys (never stolen from editable fields), engine-resolved
    const editable = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable;
    if (editable || e.target.closest?.(".soul-card")) return; // card keys are onGridKey's
    const hit = resolveViewKey(e, s.viewActions);
    if (hit) { e.preventDefault(); s.viewActions.find((a) => a.id === hit)?.run(); }
  });
  s.disposers = [
    registerAction({ id: "spawn.filter", label: "Soul roster: focus the filter", context: "stage:spawn", defaultChord: "/", run: () => s.q("filter").focus() }),
    registerAction({ id: "spawn.brain", label: "Soul roster: open Brain of focused card", context: "stage:spawn", defaultChord: "B", run: () => brainOfFocusedCard(s) }),
  ];
  // CLI degradation: refresh once on mount and re-render the grid whenever
  // availability flips — spawn buttons disable consistently with the card.
  refreshCli(ctx);
  s.unsubCli = onCliChange(() => { if (s.alive) renderGrid(s); });
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
  (state.disposers || []).forEach((off) => { try { off(); } catch {} });
  if (state.unsubWs) state.unsubWs();
  if (state.unsubCli) state.unsubCli();
  if (state.cliCardHandle) { state.cliCardHandle.dispose(); state.cliCardHandle = null; }
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
  // an OPEN spawn form: rebuilding swaps in a fresh empty form, silently
  // wiping typed-but-unsubmitted task/purpose text — the user then submits
  // the replacement and the instance spawns with NO TASK. Any open form
  // (not just a disabled in-flight one) owns the grid; the roster repaints
  // on the next poll after the form closes. Workspace switching still resets
  // synchronously before dispatching its refresh (s.sel cleared + innerHTML).
  // Explicit re-renders (cancel/select) clear or change s.sel first, so they
  // rebuild; only a form still owned by the CURRENT selection blocks repaint.
  // No dynamic selector: agent names are roster data and may contain selector
  // metacharacters (and this module's CSS constant shadows the global, so
  // CSS.escape is not available here). Compare dataset identity instead.
  // EXCEPTION (review d7becaf): a CLI-not-available transition BYPASSES form
  // preservation — the launch race (form opened while CLI state was
  // unknown, probe lands ok:false) must not leave a live submit behind a
  // missing degradation card. The selection is invalidated so the rebuild
  // shows the card and disabled buttons; doSpawn independently re-checks.
  const noCli = !cliAvailable(); // frozen contract: unknown does NOT render capable
  if (noCli && s.sel) s.sel = null, s.selAgent = null;
  if (s.sel && [...(grid.querySelectorAll?.(".soul-card") || [])]
        .some((card) => card.dataset?.agent === s.sel && card.querySelector(".soul-form"))) return;
  // capture the focused card's identity before the rebuild wipes the DOM
  const focusedAgent = s.el?.ownerDocument?.activeElement?.closest?.(".soul-card")?.dataset?.agent || null;
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
  // Roving tabindex across the rebuilt grid: keep the previously focused
  // card's identity tabbable (and focused) when it survives the repaint,
  // else the first card enters the tab order.
  const rebuilt = [...grid.querySelectorAll(".soul-card")];
  if (rebuilt.length) {
    const focused = focusedAgent && rebuilt.find((c) => c.dataset.agent === focusedAgent);
    (focused || rebuilt[0]).tabIndex = 0;
    if (focused) focused.focus({ preventScroll: true });
  }
}

/* ── grid keyboard: roving focus over cards ──────────────────────── */
function gridCards(s) { return [...s.q("souls-grid").querySelectorAll(".soul-card")]; }

function focusedCard(s) {
  const active = s.el.ownerDocument.activeElement;
  return active?.closest?.(".soul-card") || null;
}

function brainOfFocusedCard(s) {
  const card = focusedCard(s) || gridCards(s)[0];
  const a = card && s.souls.agents.find((x) => x.name === card.dataset.agent);
  if (a) s.ctx.openBrain?.(a.name);
}

function onGridKey(s, e) {
  // Keys inside the open form belong to the form (Esc handled above).
  if (e.target.closest?.(".soul-form")) return;
  const cards = gridCards(s);
  if (!cards.length) return;
  const cur = focusedCard(s);
  const at = cur ? cards.indexOf(cur) : -1;
  if (["ArrowRight", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    focusCard(s, cards, Math.min(cards.length - 1, at + 1));
  } else if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
    e.preventDefault();
    focusCard(s, cards, Math.max(0, at - 1));
  } else if (e.key === "Enter" && cur && e.target === cur) {
    e.preventDefault();
    cur.querySelector(".spawn-act:not([disabled])")?.click();
  } else if (cur && e.target === cur) {
    // ALL view actions resolve from a focused card — the primary
    // non-editable surface (review 93ff03d: '/' must reach the filter
    // from the roving card, not just 'b').
    const hit = resolveViewKey(e, s.viewActions);
    if (hit === "spawn.brain") {
      e.preventDefault();
      cur.querySelector(".brain-act:not([disabled])")?.click();
    } else if (hit) {
      e.preventDefault();
      s.viewActions.find((a) => a.id === hit)?.run();
    }
  }
}

/* Roving tabindex: exactly one card in the tab order — the focused one. */
function focusCard(s, cards, index) {
  const target = cards[index];
  if (!target) return;
  for (const c of cards) c.tabIndex = c === target ? 0 : -1;
  target.focus();
}

function soulCard(s, a) {
  const attached = a.work === "attached"; // needs an owning instance's work tree
  const noCli = !cliAvailable();          // unknown OR unavailable — mutations need a verified CLI
  const open = s.sel === a.name && !attached && !noCli;
  const card = document.createElement("div");
  card.className = "soul-card" + (attached ? " attached" : "") + (open ? " open" : "");
  card.dataset.agent = a.name;
  card.tabIndex = -1; // roving tabindex — renderGrid elects the tabbable card
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", a.name);
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
  if (!open) {
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
  // CLI gate at SUBMIT time (review d7becaf): a form opened before a state
  // flip must not dispatch — the render-time disable alone cannot cover a
  // form that was already open. Mutations require a VERIFIED compatible CLI.
  if (!cliAvailable()) {
    s.sel = null; s.selAgent = null;
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
    if (!visible) { ui.status.textContent = `Spawned ${d.instance} — roster is catching up; open it from the sidebar instance roster.`; return; }
    ui.status.textContent = `Spawned ${d.instance}${d.launched ? " — session running" : ""}. Opening terminal…`;
    s.ctx.openTerminal(d.instance);
  } catch (e) {
    if (owns()) { ui.status.classList?.add("err"); ui.status.textContent = `Spawn failed: ${e.message || e}`; }
  } finally {
    if (owns()) { ui.btn.disabled = false; ui.btn.textContent = "Spawn"; }
  }
}
