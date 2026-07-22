// OAS desktop — renderer shell: nav rail + tabbed view host.
//
// View contract (binding, from the desktop-app contract): each view is an ES
// module in ./views/ exporting mount(el, ctx) / unmount(), where
//   ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }
// The shell owns tabs/navigation and provides ctx. The full roster (with
// chat transcript, spawn, jira) lives in the ported views — the shell chrome
// stays a thin rail so nothing is duplicated.

const desk = window.oasDesktop;

// ── ctx (shared by all views) ─────────────────────────────────────────────
async function api(pathname, opts) {
  const r = await desk.api(pathname, opts);
  if (!r.ok) throw new Error(r.body?.error || `HTTP ${r.status} for ${pathname}`);
  return r.body;
}

const ctx = {
  api,
  openFile: (path) => openViewTab("markdown", `≡ ${String(path).split("/").pop()}`, { path }, `file:${path}`),
  openTerminal: (instance) => openTerminalTab(instance),
};

// ── tabs ──────────────────────────────────────────────────────────────────
const tabbar = document.getElementById("tabbar");
const tabhost = document.getElementById("tabhost");
const tabs = new Map(); // id -> { tabEl, paneEl, title, key, onClose, onShow }
let nextTabId = 1;
let activeTab = null;

/** key: optional dedup key — activating an existing tab instead of opening a
 * twin. View modules keep module-level state (they are singletons by design),
 * so one tab per view/file is also a correctness requirement. */
function addTab({ title, key, onClose, onShow }) {
  if (key) {
    for (const [tid, t] of tabs) if (t.key === key) { activateTab(tid); return null; }
  }
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
  tabs.set(id, { tabEl, paneEl, title, key, onClose, onShow });
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
async function openViewTab(name, title, extra = {}, key = `view:${name}`) {
  let mod;
  try { mod = await import(`./views/${name}.mjs`); }
  catch (e) {
    const made = addTab({ title: `${title} (missing)`, key });
    if (made) made.paneEl.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>view module failed to load: ${e.message}</div></div>`;
    return;
  }
  const made = addTab({
    title,
    key,
    onClose: () => { try { mod.unmount?.(); } catch (e) { console.error(e); } },
  });
  if (!made) return; // existing tab activated
  const el = document.createElement("div");
  el.style.height = "100%";
  made.paneEl.append(el);
  try { await mod.mount(el, { ...ctx, ...extra }); }
  catch (e) { el.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>mount failed: ${e.message}</div></div>`; }
}

// ── integrated terminal tab (the shell's own flagship view) ──────────────
async function openTerminalTab(instance) {
  const key = `term:${instance}`;
  for (const [tid, t] of tabs) if (t.key === key) { activateTab(tid); return; }

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

  const made = addTab({
    title: `⌗ ${instance}`,
    key,
    onClose: cleanup,
    onShow: () => { requestAnimationFrame(() => { try { fit.fit(); } catch {} }); },
  });
  made.paneEl.append(wrap);
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
    if (!made.paneEl.classList.contains("active")) return;
    try { fit.fit(); } catch { /* zero-size while hidden */ }
  });
  ro.observe(wrap);
  term.focus();
}

// ── nav rail ──────────────────────────────────────────────────────────────
const NAV = [
  { name: "instances", label: "Instances", icon: "◉", title: "Instances" },
  { name: "spawn", label: "Spawn", icon: "✚", title: "Spawn" },
  { name: "brain", label: "Brain", icon: "◈", title: "Agent brain" },
  { name: "jira", label: "Jira", icon: "◫", title: "Jira" },
  // diff.mjs is a placeholder until the viewers developer ships it; the nav
  // entry keeps its integration mechanical.
  { name: "diff", label: "Diff", icon: "±", title: "Diff" },
];
const navEl = document.getElementById("nav");
for (const v of NAV) {
  const b = document.createElement("button");
  b.className = "nav-item";
  b.title = v.title;
  b.innerHTML = `<span class="icon"></span><span class="label"></span>`;
  b.querySelector(".icon").textContent = v.icon;
  b.querySelector(".label").textContent = v.label;
  b.addEventListener("click", () => openViewTab(v.name, v.title));
  navEl.append(b);
}

document.getElementById("ws-name").textContent = "";
api("/api/panel").then((p) => {
  document.getElementById("ws-name").textContent = p.workspace?.name ? `· ${p.workspace.name}` : "";
}).catch(() => {});

// Home view.
openViewTab("instances", "Instances");
