/* oas desktop — Instances view: roster + instance detail.
   Ports the web panel's roster and the pi-style chat transcript
   (/api/chat/<instance>) into a desktop renderer view, plus a task/state/git
   summary.
   The live terminal is NOT here — "Open terminal" hands off to the shell's
   terminal view via ctx.openTerminal(instance) (contract; tui-dev owns it).
   Contract: export mount(el, ctx) / unmount(). Plain ES module + DOM. */
import {
  escapeHtml, miniMarkdown, apiJson, postJson, ensureTheme,
  currentWorkspace, setWorkspace, adoptWorkspace, onWorkspaceChange,
  renderWorkspaceSelect, wsQuery, instanceApiPath, workspaceGeneration,
} from "./common.mjs";
import { ROSTER_SORTS, groupRosterFamilies, rosterGroupKey } from "../instance-tree.mjs";

let state = null;

const SORT_KEY = "oas.desktop.rosterSort";
/* Sort choice is WORKSPACE-SCOPED like the group collapse state (PR #29
   maintainer finding): persisted as a { [canonicalWsId]: sortId } map so
   workspace A's choice never leaks into B. Unknown/invalid persisted values
   fall back to "status". Exported for the A→B→A round-trip regression. */
export function savedSort(ws) {
  try {
    const map = JSON.parse(localStorage.getItem(SORT_KEY) || "{}");
    const v = map && typeof map === "object" ? map[ws || ""] : null;
    return ROSTER_SORTS.some((s) => s.id === v) ? v : "status";
  } catch { return "status"; }
}
function persistSort(ws, sortBy) {
  try {
    let map;
    try { map = JSON.parse(localStorage.getItem(SORT_KEY) || "{}"); } catch { map = {}; }
    if (!map || typeof map !== "object" || Array.isArray(map)) map = {};
    map[ws || ""] = sortBy;
    localStorage.setItem(SORT_KEY, JSON.stringify(map));
  } catch { /* storage-less env */ }
}
/* Re-read the persisted sort for the CURRENT workspace and sync the control.
   Called on workspace switch and on silent server-side adoption. */
function syncSortToWorkspace(s) {
  s.sortBy = savedSort(currentWorkspace());
  const sel = s.q("sortsel");
  if (sel) sel.value = s.sortBy;
}

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = {
    el, ctx,
    panel: { instances: [] },
    sel: null,
    filterText: "",
    sortBy: savedSort(currentWorkspace()),
    collapsedGroups: new Set(),   // rosterGroupKey(ws, repo[, family]) — ws-scoped
    pendingSends: [],
    fastPollUntil: 0,
    chatReq: 0,               // request generation — stale responses never paint
    lastChatSig: "",
    lastChatData: null,
    openTools: new Set(),
    timers: [],
    unsubWs: null,
    alive: true,
  };
  el.innerHTML = `
    <div class="oas-view">
      <div class="side">
        <div class="filterbar bar">
          <select class="field wssel" style="display:none"></select>
          <input class="field filter" placeholder="Filter agents, repos, tasks…" autocomplete="off">
          <select class="field sortsel" title="Sort instances within groups">${ROSTER_SORTS.map((o) =>
            `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join("")}</select>
        </div>
        <div class="groups"><div class="loading-block"><span class="spinner"></span> Loading roster…</div></div>
      </div>
      <div class="detail">
        <div class="vhead" style="display:none">
          <div class="row1">
            <span class="title"></span>
            <span class="badge off"></span>
            <span class="actions">
              <button class="act termbtn" title="Open the live terminal for this session">Open terminal</button>
              <button class="act danger intbtn" title="Send Ctrl-C to the session">Interrupt</button>
            </span>
          </div>
          <div class="row2"></div>
        </div>
        <div class="chat"><div class="empty"><span class="big">⌥</span>Select an instance to follow its session.<br>The transcript is read-only here — <b>Open terminal</b> to interact.</div></div>
      </div>
    </div>`;
  s.q = (cls) => el.querySelector("." + cls);
  s.q("filter").addEventListener("input", (e) => { s.filterText = e.target.value; renderRoster(s); });
  const sortSel = s.q("sortsel");
  sortSel.value = s.sortBy;
  sortSel.addEventListener("change", (e) => {
    s.sortBy = e.target.value;
    persistSort(currentWorkspace(), s.sortBy);
    renderRoster(s);
  });
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.q("termbtn").onclick = () => { if (s.sel) s.ctx.openTerminal(s.sel); };
  s.q("intbtn").onclick = async () => {
    if (!s.sel) return;
    try { await postJson(s.ctx, instanceApiPath("interrupt", s.sel), {}); } catch { /* idle instance */ }
    setTimeout(() => refreshChat(s, true), 350);
  };
  s.unsubWs = onWorkspaceChange(() => { clearSelection(s); syncSortToWorkspace(s); refreshPanel(s); });
  refreshPanel(s);
  s.timers.push(setInterval(() => refreshPanel(s), 4000));
  s.timers.push(setInterval(() => refreshChat(s, false), 1500));
  s.timers.push(setInterval(() => { if (Date.now() < s.fastPollUntil) refreshChat(s, false); }, 400));
}

export function unmount() {
  if (!state) return;
  state.alive = false;
  state.timers.forEach(clearInterval);
  if (state.unsubWs) state.unsubWs();
  state.el.innerHTML = "";
  state = null;
}

/* ── roster ── */
function matches(s, i) {
  if (!s.filterText) return true;
  const t = s.filterText.toLowerCase();
  return [i.instance, i.agent, i.repoName, i.task, i.branch].some((v) => String(v || "").toLowerCase().includes(t));
}

async function refreshPanel(s) {
  const myGen = workspaceGeneration();       // capture at dispatch
  let panel;
  try { panel = await apiJson(s.ctx, `/api/panel${wsQuery()}`); }
  catch { return; } // keep last good roster on transient errors
  // discard deferred roster responses from a previous workspace
  if (!s.alive || myGen !== workspaceGeneration()) return;
  s.panel = panel;
  if (panel.workspace && panel.workspace.id !== currentWorkspace()) {
    // server resolved our (possibly stale) ws to a real one — adopt it
    // silently, then re-scope the sort to the adopted workspace
    adoptWorkspace(panel.workspace.id);
    syncSortToWorkspace(s);
  }
  renderWorkspaceSelect(s.q("wssel"), panel.workspaces, panel.workspace?.id || "");
  renderRoster(s);
  if (s.sel) {
    const i = panel.instances.find((x) => x.instance === s.sel);
    if (i) renderHead(s, i);
  }
}

function renderRoster(s) {
  const el = s.q("groups");
  el.innerHTML = "";
  const visible = s.panel.instances.filter((i) => matches(s, i));
  if (!s.panel.instances.length) {
    el.innerHTML = '<div class="empty"><span class="big">◎</span>No instances yet.<br>Spawn one from the Spawn view or with <code>oas spawn &lt;agent&gt;</code>.</div>';
    return;
  }
  if (!visible.length) { el.innerHTML = '<div class="empty">Nothing matches the filter.</div>'; return; }
  // Filtering force-expands all groups (matches would otherwise hide inside
  // collapsed headers) WITHOUT mutating the persisted collapse state.
  const filtering = !!s.filterText.trim();
  const ws = currentWorkspace();
  const groupHeader = (cls, label, key, count) => {
    const collapsed = !filtering && s.collapsedGroups.has(key);
    const h = document.createElement("button");
    h.type = "button";
    h.className = cls + (collapsed ? " closed" : "");
    h.setAttribute("aria-expanded", String(!collapsed));
    h.innerHTML = `<span class="tri" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>`
      + `<span class="glabel">${escapeHtml(label)}</span>`
      + (count ? `<span class="count">${escapeHtml(count)}</span>` : "");
    if (filtering) {
      h.disabled = true;
      h.title = "Filtering temporarily expands all groups";
    } else {
      h.addEventListener("click", () => {
        collapsed ? s.collapsedGroups.delete(key) : s.collapsedGroups.add(key);
        renderRoster(s);
      });
    }
    return { header: h, collapsed };
  };
  for (const [rName, families] of groupRosterFamilies(visible, s.sortBy)) {
    const g = document.createElement("div");
    const all = [...families.values()].flat();
    const runningN = all.filter((i) => i.running).length;
    const repoKey = rosterGroupKey(ws, rName);
    const { header: rh, collapsed: repoClosed } =
      groupHeader("ghead", rName, repoKey, `${runningN}/${all.length} running`);
    g.appendChild(rh);
    if (!repoClosed) {
      for (const [fName, items] of families) {
        const fbox = document.createElement("div");
        const famKey = rosterGroupKey(ws, rName, fName);
        const { header: fh, collapsed: famClosed } =
          groupHeader("rhead", fName, famKey, String(items.length));
        fbox.appendChild(fh);
        if (!famClosed) for (const i of items) fbox.appendChild(instRow(s, i));
        g.appendChild(fbox);
      }
    }
    el.appendChild(g);
  }
}

function instRow(s, i) {
  const d = document.createElement("div");
  d.className = "inst" + (s.sel === i.instance ? " sel" : "") + (i.running ? "" : " idle") + (i.depth ? " child" : "");
  if (i.depth > 1) d.style.marginLeft = `${i.depth * 18}px`;
  d.innerHTML = `
    <div class="iname"><span class="dot ${i.running ? "on" : ""}"></span>${escapeHtml(i.instance)}</div>
    <div class="itask">${escapeHtml((i.task || "").slice(0, 100))}</div>
    <div class="imeta">
      <span class="chip rt">${escapeHtml(i.runtime)}</span>
      <span class="chip">${escapeHtml(i.work)}${i.branch ? " · " + escapeHtml(i.branch) : ""}</span>
      ${i.git && i.git.dirty ? `<span class="chip dirty">±${Number(i.git.dirty)}</span>` : ""}
    </div>`;
  d.onclick = () => select(s, i.instance);
  return d;
}

/* ── selection + detail head ── */
function clearSelection(s) {
  s.sel = null; s.lastChatSig = ""; s.lastChatData = null;
  s.pendingSends.length = 0; s.chatReq++;
  s.q("vhead").style.display = "none";
  s.q("chat").innerHTML = '<div class="empty"><span class="big">⌥</span>Select an instance to follow its session.</div>';
}

function select(s, name) {
  s.sel = name;
  const i = s.panel.instances.find((x) => x.instance === name);
  if (i) renderHead(s, i);
  renderRoster(s);
  s.lastChatSig = ""; s.lastChatData = null;
  s.chatReq++;                       // invalidate in-flight fetches for the old instance
  s.pendingSends.length = 0;
  s.q("chat").innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading session…</div>';
  refreshChat(s, true);
}

function renderHead(s, i) {
  const vh = s.q("vhead");
  vh.style.display = "block";
  vh.querySelector(".title").textContent = i.instance;
  const b = vh.querySelector(".badge");
  b.textContent = i.running ? "running" : "idle";
  b.className = "badge " + (i.running ? "on" : "off");
  vh.querySelector(".row2").innerHTML = [
    `soul <b>${escapeHtml(i.agent)}</b>`,
    `repo <b>${escapeHtml(i.repoName)}</b>${i.branch ? ` @ <b>${escapeHtml(i.branch)}</b>` : ""}`,
    `mode <b>${escapeHtml(i.work || "")}</b>`,
    `runtime <b>${escapeHtml(i.runtime || "")}</b>${i.model ? ` (${escapeHtml(i.model)})` : ""}`,
    i.git && i.git.dirty ? `git <b>±${Number(i.git.dirty)}</b>` : "",
    i.workspace ? `workspace <b>${escapeHtml(String(i.workspace).split("/").pop())}</b>` : "",
    i.next ? `next: ${escapeHtml(String(i.next).slice(0, 110))}` : "",
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
}

/* ── transcript rendering — ported from the panel's pi-style chat view ── */
function toolCommand(t) {
  const a = t.args || {};
  if (t.name === "bash") return { verb: "$", cmd: a.command || "" };
  if (t.name === "read") return { verb: "Read", cmd: a.path || a.file_path || "" };
  if (t.name === "edit") return { verb: "Edited", cmd: a.path || a.file_path || "" };
  if (t.name === "write") return { verb: "Wrote", cmd: a.path || a.file_path || "" };
  if (t.name === "workflow") {
    const meta = workflowMeta(t);
    return { verb: "Workflow", cmd: meta.name || "dynamic workflow" };
  }
  const first = Object.values(a).find((v) => typeof v === "string");
  return { verb: t.name, cmd: first || JSON.stringify(a).slice(0, 120) };
}
/* pi dynamic-workflows: the tool call carries a JS script whose
   `export const meta = { name, description }` names the workflow. */
function workflowMeta(t) {
  const script = String((t.args || {}).script || "");
  const name = (script.match(/meta\s*=\s*\{[^}]*?name:\s*['"`]([^'"`]+)['"`]/) || [])[1];
  const description = (script.match(/meta\s*=\s*\{[^}]*?description:\s*['"`]([^'"`]+)['"`]/) || [])[1];
  return { name, description };
}
function workflowResult(t) {
  const out = String(t.result || "");
  const head = (out.match(/^Workflow\s+(\S+)\s+(completed|failed)[^\n]*/) || [])[0];
  const agents = (out.match(/with\s+(\d+)\s+agent/) || [])[1];
  return { head, agents, body: out };
}
const PREVIEW_LINES = 5;
function workflowHtml(s, tool, key) {
  const open = s.openTools.has(key);
  const running = tool.result === null;
  const meta = workflowMeta(tool);
  const res = running ? null : workflowResult(tool);
  const failed = res && /failed/.test(res.head || "");
  return `<div class="tool wf ${running ? "running" : failed ? "failed" : "done"}">
    <div class="wfhead" data-tool="${escapeHtml(key)}">
      <span class="wfmark">◆</span>
      <span class="wfname">Workflow: ${escapeHtml(meta.name || "dynamic")}</span>
      <span class="wfstate">${running ? '<span class="spinner"></span> running' : failed ? "✗ failed" : `✓ completed${res.agents ? ` · ${res.agents} agents` : ""}`}</span>
    </div>
    ${meta.description ? `<div class="wfdesc">${escapeHtml(meta.description)}</div>` : ""}
    ${!running && open ? `<div class="toolout full">${escapeHtml(res.body)}</div><div class="more" data-tool="${escapeHtml(key)}">collapse</div>`
      : !running ? `<div class="more" data-tool="${escapeHtml(key)}">show result</div>` : ""}
  </div>`;
}
function toolHtml(s, tool, key) {
  if (tool.name === "workflow") return workflowHtml(s, tool, key);
  const open = s.openTools.has(key);
  const { verb, cmd } = toolCommand(tool);
  const running = tool.result === null;
  const out = (tool.result || "").replace(/\n+$/, "");
  const lines = out ? out.split("\n") : [];
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const hidden = lines.length - PREVIEW_LINES;
  return `<div class="tool">
    <div class="toolhead ${running ? "running" : ""}" data-tool="${escapeHtml(key)}">
      <span class="tverb">${running ? "●" : "✓"} ${escapeHtml(verb)}</span><span class="tcmd">${escapeHtml(cmd)}</span>
    </div>
    ${running ? "" : open
      ? `<div class="toolout full">${escapeHtml(out || "(no output)")}</div><div class="more" data-tool="${escapeHtml(key)}">collapse</div>`
      : preview
        ? `<div class="toolout">${escapeHtml(preview)}</div>${hidden > 0 ? `<div class="more" data-tool="${escapeHtml(key)}">… ${hidden} more lines</div>` : ""}`
        : ""}
  </div>`;
}
function turnHtml(s, t, idx) {
  if (t.role === "user") {
    return `<div class="turn user"><div class="utext">${escapeHtml(t.text)}</div></div>`;
  }
  let inner = "";
  if (t.thinking) inner += `<details class="thinking"><summary>thinking</summary><div class="tbody">${escapeHtml(t.thinking)}</div></details>`;
  for (const [j, tool] of (t.tools || []).entries()) inner += toolHtml(s, tool, `${idx}:${j}`);
  if (t.text) inner += `<div class="atext">${miniMarkdown(t.text)}</div>`;
  if (!inner) return "";
  return `<div class="turn ai">${inner}</div>`;
}

/* ── transcript copy support ──
   The chat re-renders by innerHTML replacement on a 1.5s (or 400ms fast)
   poll; any repaint destroys an in-progress mouse selection, which made the
   transcript effectively uncopyable. A background repaint must therefore
   yield to a live selection inside the box — the skipped frame retries on
   the next tick once the user has copied or clicked away. Pure; exported
   for tests. */
export function selectionBlocksRepaint(box, doc = box.ownerDocument) {
  const sel = doc.defaultView?.getSelection?.() || doc.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  return box.contains(range.commonAncestorContainer);
}

function renderChat(s, d, scroll) {
  const box = s.q("chat");
  if (!d) return;
  // A live selection in the transcript wins over a background repaint —
  // clear the signature so the skipped update paints on a later tick.
  if (!scroll && selectionBlocksRepaint(box)) { s.lastChatSig = ""; return; }
  if (!d.available) { box.innerHTML = '<div class="empty"><span class="big">⎀</span>No session transcript found for this instance.</div>'; return; }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let html = d.turns.map((t, i) => turnHtml(s, t, i)).join("") || "";
  // live indicator: a tool call in flight, or the last turn is the human's
  // (the agent is thinking — its reply lands only when a block completes)
  const last = d.turns.at(-1);
  const busy = (last && last.role === "user")
    || (last && last.role === "assistant" && (last.tools || []).some((t) => t.result === null));
  if (busy) html += `<div class="turn ai"><div class="working"><span class="spinner"></span> ${last?.role === "user" ? "agent is thinking" : "agent is working"}<span class="dots"><span>.</span><span>.</span><span>.</span></span></div></div>`;
  box.innerHTML = html || '<div class="empty">No messages yet.</div>';
  // tool expand/collapse — event delegation, no inline handlers
  for (const elx of box.querySelectorAll("[data-tool]")) {
    elx.addEventListener("click", () => {
      const key = elx.dataset.tool;
      s.openTools.has(key) ? s.openTools.delete(key) : s.openTools.add(key);
      s.lastChatSig = "";
      renderChat(s, s.lastChatData, false);
    });
  }
  if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
}

async function refreshChat(s, scroll) {
  if (!s || !s.alive || !s.sel || document.hidden) return;
  const forSel = s.sel;
  const myReq = ++s.chatReq;
  let d;
  try { d = await apiJson(s.ctx, instanceApiPath("chat", forSel, "limit=150")); }
  catch { return; } // keep the last good render on transient fetch errors
  // A newer request finished first, or the user switched instance mid-flight:
  // this payload belongs to another view — never let it paint.
  if (!s.alive || myReq !== s.chatReq || forSel !== s.sel) return;
  s.lastChatData = d;
  const sig = forSel + ":" + d.turns.length + (d.turns.at(-1)?.text || "") + (d.turns.at(-1)?.tools?.length || 0)
    + ":" + (d.turns.at(-1)?.tools || []).filter((t) => t.result === null).length
    + ":" + (d.turns.at(-1)?.role || "");
  if (sig === s.lastChatSig && !scroll) return; // avoid re-render flicker
  s.lastChatSig = sig;
  renderChat(s, d, scroll);
}
