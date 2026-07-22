// OAS desktop — renderer shell: sidebar roster + agents, tabbed view host.
//
// View contract (binding, from the desktop-app contract): each view is an ES
// module in ./views/ exporting mount(el, ctx) / unmount(), where
//   ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }
// The shell owns tabs/navigation and provides ctx.

const desk = window.oasDesktop;

// ── ctx (shared by all views) ─────────────────────────────────────────────
async function api(pathname, opts) {
  const r = await desk.api(pathname, opts);
  if (!r.ok) throw new Error(r.body?.error || `HTTP ${r.status} for ${pathname}`);
  return r.body;
}

const ctx = {
  api,
  openFile: (path) => openViewTab("markdown", `file: ${String(path).split("/").pop()}`, { path }),
  openTerminal: (instance) => openTerminalTab(instance),
};

// ── tabs ──────────────────────────────────────────────────────────────────
const tabbar = document.getElementById("tabbar");
const tabhost = document.getElementById("tabhost");
const tabs = new Map(); // id -> { tabEl, paneEl, view, title, onClose, onShow }
let nextTabId = 1;
let activeTab = null;

function addTab({ title, onClose, onShow }) {
  const id = nextTabId++;
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  const label = document.createElement("span");
  label.textContent = title;
  const close = document.createElement("span");
  close.className = "close";
  close.textContent = "×";
  tabEl.append(label, close);
  const paneEl = document.createElement("div");
  paneEl.className = "tab-pane";
  tabbar.append(tabEl);
  tabhost.append(paneEl);
  tabEl.addEventListener("click", (e) => { if (e.target !== close) activateTab(id); });
  close.addEventListener("click", () => closeTab(id));
  tabs.set(id, { tabEl, paneEl, title, onClose, onShow });
  activateTab(id);
  return { id, paneEl };
}

function activateTab(id) {
  activeTab = id;
  for (const [tid, t] of tabs) {
    t.tabEl.classList.toggle("active", tid === id);
    t.paneEl.classList.toggle("active", tid === id);
  }
  tabs.get(id)?.onShow?.();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  try { t.onClose?.(); } catch (e) { console.error(e); }
  t.tabEl.remove();
  t.paneEl.remove();
  tabs.delete(id);
  if (activeTab === id) {
    const rest = [...tabs.keys()];
    if (rest.length) activateTab(rest[rest.length - 1]);
    else activeTab = null;
  }
}

// ── view host: load ./views/<name>.mjs, mount into a tab ─────────────────
async function openViewTab(name, title, extra = {}) {
  let mod;
  try { mod = await import(`./views/${name}.mjs`); }
  catch (e) {
    const { paneEl } = addTab({ title: `${title} (missing)` });
    paneEl.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>view module failed to load: ${e.message}</div></div>`;
    return;
  }
  const { paneEl } = addTab({
    title,
    onClose: () => { try { mod.unmount?.(); } catch (e) { console.error(e); } },
  });
  const el = document.createElement("div");
  el.style.height = "100%";
  paneEl.append(el);
  try { await mod.mount(el, { ...ctx, ...extra }); }
  catch (e) { el.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>mount failed: ${e.message}</div></div>`; }
}

// ── integrated terminal tab (the shell's own flagship view) ──────────────
async function openTerminalTab(instance) {
  // Resolve the tmux target from the roster.
  const panel = await api("/api/panel");
  const inst = panel.instances.find((i) => i.instance === instance);
  if (!inst) return alert(`unknown instance "${instance}"`);
  if (!inst.running || !inst.tmux?.session) return alert(`"${instance}" has no live tmux session`);

  const wrap = document.createElement("div");
  wrap.className = "term-wrap";

  const term = new Terminal({
    fontSize: 13,
    fontFamily: "SF Mono, Menlo, monospace",
    theme: { background: "#16161e", foreground: "#c0caf5" },
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  let ptyId = null;
  let offData = null, offExit = null;
  let ro = null;

  const cleanup = () => {
    // Detach only: kill the viewer pty; NEVER the tmux session.
    offData?.(); offExit?.();
    ro?.disconnect();
    if (ptyId !== null) desk.termClose(ptyId);
    ptyId = null;
    term.dispose();
  };

  const { paneEl } = addTab({
    title: `⌗ ${instance}`,
    onClose: cleanup,
    onShow: () => { requestAnimationFrame(() => { try { fit.fit(); } catch {} }); },
  });
  paneEl.append(wrap);
  term.open(wrap);
  fit.fit();

  ptyId = await desk.termOpen({
    session: inst.tmux.session,
    window: inst.tmux.window,
    cols: term.cols,
    rows: term.rows,
  });

  offData = desk.onTermData(ptyId, (data) => term.write(data));
  offExit = desk.onTermExit(ptyId, () => {
    ptyId = null;
    const banner = document.createElement("div");
    banner.className = "term-banner";
    banner.textContent = "session ended — close this tab";
    wrap.append(banner);
  });
  term.onData((data) => { if (ptyId !== null) desk.termWrite(ptyId, data); });
  term.onResize(({ cols, rows }) => { if (ptyId !== null) desk.termResize(ptyId, cols, rows); });

  ro = new ResizeObserver(() => {
    if (!paneEl.classList.contains("active")) return;
    try { fit.fit(); } catch { /* zero-size while hidden */ }
  });
  ro.observe(wrap);
  term.focus();
}

// ── sidebar: roster + agents ──────────────────────────────────────────────
const rosterEl = document.getElementById("roster");
const agentsEl = document.getElementById("agents");
const wsNameEl = document.getElementById("ws-name");
let selectedInstance = null;

function instItem(i) {
  const el = document.createElement("div");
  el.className = "side-item" + (i.instance === selectedInstance ? " selected" : "");
  el.innerHTML = `
    <div class="name"><span class="dot${i.running ? " running" : ""}"></span><span></span></div>
    <div class="meta"></div>
    <div class="actions"></div>`;
  el.querySelector(".name span:last-child").textContent = i.instance;
  el.querySelector(".meta").textContent = [i.agent, i.branch].filter(Boolean).join(" · ");
  const actions = el.querySelector(".actions");
  for (const [label, fn] of [
    ["Terminal", () => ctx.openTerminal(i.instance)],
    ["Brain", () => openViewTab("brain", `brain: ${i.agent}`, { agent: i.agent, instance: i.instance, agentsRoot: i.agentsRoot })],
    ["Diff", () => openViewTab("diff", `diff: ${i.instance}`, { instance: i.instance })],
    ["Chat", () => openViewTab("chat", `chat: ${i.instance}`, { instance: i.instance })],
  ]) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    actions.append(b);
  }
  el.addEventListener("click", () => { selectedInstance = i.instance; refreshRoster(); });
  return el;
}

let lastPanelJson = "";
async function refreshRoster() {
  let panel;
  try { panel = await api("/api/panel"); }
  catch (e) { rosterEl.innerHTML = `<div class="side-empty">server unreachable: ${e.message}</div>`; return; }
  wsNameEl.textContent = panel.workspace?.name ? `· ${panel.workspace.name}` : "";
  const json = JSON.stringify(panel.instances) + selectedInstance;
  if (json === lastPanelJson) return; // avoid pointless DOM churn on poll
  lastPanelJson = json;
  rosterEl.replaceChildren(...(panel.instances.length
    ? panel.instances.map(instItem)
    : [Object.assign(document.createElement("div"), { className: "side-empty", textContent: "no instances" })]));
}

async function refreshAgents() {
  let data;
  try { data = await api("/api/agents"); } catch { return; }
  agentsEl.replaceChildren(...data.agents.map((a) => {
    const el = document.createElement("div");
    el.className = "side-item";
    el.innerHTML = `<div class="name"><span></span></div><div class="meta"></div>`;
    el.querySelector(".name span").textContent = a.name;
    el.querySelector(".meta").textContent = a.description;
    el.title = a.description;
    return el;
  }));
}

refreshRoster();
refreshAgents();
setInterval(refreshRoster, 3000);
setInterval(refreshAgents, 30000);
