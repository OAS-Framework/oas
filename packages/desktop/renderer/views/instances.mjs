/* oas desktop — Instances view: roster + instance detail.
   Ports the web panel's roster and the pi-style chat transcript
   (/api/chat/<instance>) into a desktop renderer view, plus a task/state/git
   summary and an inline Jira panel when the instance has oas.jira meta.
   The live terminal is NOT here — "Open terminal" hands off to the shell's
   terminal view via ctx.openTerminal(instance) (contract; tui-dev owns it).
   Contract: export mount(el, ctx) / unmount(). Plain ES module + DOM. */
import {
  escapeHtml, miniMarkdown, apiJson, postJson, ensureTheme,
  groupInstances, currentWorkspace, setWorkspace, adoptWorkspace, onWorkspaceChange,
  renderWorkspaceSelect, wsQuery,
} from "./common.mjs";

let state = null;

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = {
    el, ctx,
    panel: { instances: [] },
    jira: null,               // last /api/jira payload for the selected instance
    sel: null,
    filterText: "",
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
        <div class="filterbar">
          <select class="field wssel" style="display:none"></select>
        </div>
        <div class="filterbar" style="padding-top:0">
          <input class="field filter" placeholder="Filter agents, repos, tasks…" autocomplete="off">
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
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.q("termbtn").onclick = () => { if (s.sel) s.ctx.openTerminal(s.sel); };
  s.q("intbtn").onclick = async () => {
    if (!s.sel) return;
    try { await postJson(s.ctx, `/api/interrupt/${encodeURIComponent(s.sel)}`, {}); } catch { /* idle instance */ }
    setTimeout(() => refreshChat(s, true), 350);
  };
  s.unsubWs = onWorkspaceChange(() => { clearSelection(s); refreshPanel(s); });
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
  let panel;
  try { panel = await apiJson(s.ctx, `/api/panel${wsQuery()}`); }
  catch { return; } // keep last good roster on transient errors
  if (!s.alive) return;
  s.panel = panel;
  if (panel.workspace && panel.workspace.id !== currentWorkspace()) {
    // server resolved our (possibly stale) ws to a real one — adopt it silently
    adoptWorkspace(panel.workspace.id);
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
  for (const [wsName, repos] of groupInstances(visible)) {
    const g = document.createElement("div");
    const total = [...repos.values()].reduce((n, v) => n + v.length, 0);
    const runningN = [...repos.values()].flat().filter((i) => i.running).length;
    const h = document.createElement("div");
    h.className = "ghead";
    h.innerHTML = `${escapeHtml(wsName)} <span class="count">${runningN}/${total} running</span>`;
    g.appendChild(h);
    const multiRepo = repos.size > 1;
    for (const [rName, items] of repos) {
      const rbox = document.createElement("div");
      if (multiRepo) { const rh = document.createElement("div"); rh.className = "rhead"; rh.textContent = rName; rbox.appendChild(rh); }
      for (const i of items) {
        const d = document.createElement("div");
        d.className = "inst" + (s.sel === i.instance ? " sel" : "") + (i.running ? "" : " idle") + (i.depth ? " child" : "");
        d.innerHTML = `
          <div class="iname"><span class="dot ${i.running ? "on" : ""}"></span>${escapeHtml(i.instance)}</div>
          <div class="itask">${escapeHtml((i.task || "").slice(0, 100))}</div>
          <div class="imeta">
            <span class="chip rt">${escapeHtml(i.runtime)}</span>
            <span class="chip">${escapeHtml(i.work)}${i.branch ? " · " + escapeHtml(i.branch) : ""}</span>
            ${i.git && i.git.dirty ? `<span class="chip dirty">±${Number(i.git.dirty)}</span>` : ""}
            ${i.jira ? '<span class="chip">jira</span>' : ""}
          </div>`;
        d.onclick = () => select(s, i.instance);
        rbox.appendChild(d);
      }
      g.appendChild(rbox);
    }
    el.appendChild(g);
  }
}

/* ── selection + detail head ── */
function clearSelection(s) {
  s.sel = null; s.lastChatSig = ""; s.lastChatData = null; s.jira = null;
  s.pendingSends.length = 0; s.chatReq++;
  s.q("vhead").style.display = "none";
  s.q("chat").innerHTML = '<div class="empty"><span class="big">⌥</span>Select an instance to follow its session.</div>';
}

function select(s, name) {
  s.sel = name;
  const i = s.panel.instances.find((x) => x.instance === name);
  if (i) renderHead(s, i);
  renderRoster(s);
  s.lastChatSig = ""; s.lastChatData = null; s.jira = null;
  s.chatReq++;                       // invalidate in-flight fetches for the old instance
  s.pendingSends.length = 0;
  s.q("chat").innerHTML = '<div class="loading-block"><span class="spinner"></span> Loading session…</div>';
  refreshChat(s, true);
  refreshJira(s, name);
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

/* ── jira (inline card at the top of the transcript when meta is present) ── */
async function refreshJira(s, name) {
  let d;
  try { d = await apiJson(s.ctx, `/api/jira/${encodeURIComponent(name)}`); }
  catch { return; }
  if (!s.alive || s.sel !== name) return;
  s.jira = d && d.enabled ? d : null;
  s.lastChatSig = "";                 // repaint transcript with the jira card
  if (s.lastChatData) renderChat(s, s.lastChatData, false);
}

export function jiraCardHtml(d) {
  if (!d || !d.enabled) return "";
  if (d.error) return `<div class="turn ai"><div class="card"><h3>Jira · ${escapeHtml(d.label || "")}</h3><div class="body">${escapeHtml(d.error)}</div></div></div>`;
  let inner = "";
  if (d.epic) {
    inner += `<div class="body"><span class="jkey">${escapeHtml(d.epic.key)}</span> ${escapeHtml(d.epic.summary || "")}${d.epic.status ? ` <span class="chip">${escapeHtml(d.epic.status)}</span>` : ""}</div>`;
    if (Array.isArray(d.epic.roster) && d.epic.roster.length) {
      const cols = Object.keys(d.epic.roster[0]);
      inner += `<table class="jt"><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>` +
        d.epic.roster.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c] || "")}</td>`).join("")}</tr>`).join("") +
        "</tbody></table>";
    }
  }
  if (Array.isArray(d.tickets) && d.tickets.length) {
    inner += `<table class="jt"><thead><tr><th>Key</th><th>Type</th><th>Summary</th><th>Status</th></tr></thead><tbody>` +
      d.tickets.map((t) => `<tr><td class="jkey">${escapeHtml(t.key)}</td><td>${escapeHtml(t.type)}</td><td>${escapeHtml(t.summary)}</td><td>${escapeHtml(t.status)}</td></tr>`).join("") +
      "</tbody></table>";
  }
  if (!inner) inner = '<div class="body">No open tickets.</div>';
  return `<div class="turn ai"><div class="card"><h3>Jira · ${escapeHtml(d.label || "")}</h3>${inner}</div></div>`;
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

function renderChat(s, d, scroll) {
  const box = s.q("chat");
  if (!d) return;
  if (!d.available) { box.innerHTML = '<div class="empty"><span class="big">⎀</span>No session transcript found for this instance.</div>'; return; }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let html = jiraCardHtml(s.jira);
  html += d.turns.map((t, i) => turnHtml(s, t, i)).join("") || "";
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
  try { d = await apiJson(s.ctx, `/api/chat/${encodeURIComponent(forSel)}?limit=150`); }
  catch { return; } // keep the last good render on transient fetch errors
  // A newer request finished first, or the user switched instance mid-flight:
  // this payload belongs to another view — never let it paint.
  if (!s.alive || myReq !== s.chatReq || forSel !== s.sel) return;
  s.lastChatData = d;
  const sig = forSel + ":" + d.turns.length + (d.turns.at(-1)?.text || "") + (d.turns.at(-1)?.tools?.length || 0)
    + ":" + (d.turns.at(-1)?.tools || []).filter((t) => t.result === null).length
    + ":" + (d.turns.at(-1)?.role || "") + ":" + (s.jira ? "j" : "");
  if (sig === s.lastChatSig && !scroll) return; // avoid re-render flicker
  s.lastChatSig = sig;
  renderChat(s, d, scroll);
}
