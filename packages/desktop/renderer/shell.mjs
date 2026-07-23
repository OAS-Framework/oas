// OAS desktop — renderer shell: nav rail + tabbed view host.
//
// View contract (binding, from the desktop-app contract): each view is an ES
// module in ./views/ exporting mount(el, ctx) / unmount(), where
//   ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }
// The shell owns tabs/navigation and provides ctx. The full roster (with
// chat transcript, spawn, jira) lives in the ported views — the shell chrome
// stays a thin rail so nothing is duplicated.
import { currentWorkspace } from "./views/common.mjs";
import { initTheme, toggleTheme, xtermTheme, onThemeChange } from "./theme.mjs";
import { createPalette } from "./palette.mjs";
import { createViewLifecycle } from "./view-lifecycle.mjs";
import { reserveKey, whenKeyFree } from "./tab-keys.mjs";
import { createTerminalTab } from "./terminal-tab.mjs";

const desk = window.oasDesktop;
initTheme();

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
  // additive shell affordance (views feature-detect it): switch the STAGE
  // to a named sidebar view (stage views are not tabs — see below).
  openView: (name) => showStage(name),
};

// ── stage: the sidebar-driven main surface ──────────────────────────
// Sidebar items switch the stage view in place; they never create tabs.
// The tab strip is reserved for OPENED ARTIFACTS (terminals, files): things
// you accumulate and close, not places you navigate. Selecting a nav item
// hides the tab layer; activating a tab covers the stage.
const stageHost = document.getElementById("stagehost");
let stage = null;           // { name, life, el }
let stageOp = 0;            // switch generation — a slow mount must not paint over a newer switch

async function showStage(name) {
  const v = NAV.find((x) => x.name === name);
  setNavActive(name);
  showTabLayer(false);
  if (stage && stage.name === name) return;   // already on this surface
  const myOp = ++stageOp;
  const prev = stage;
  stage = null;
  if (prev) { try { await prev.life.close(); } catch (e) { console.error(e); } prev.el.remove(); }
  if (myOp !== stageOp) return;               // superseded by a faster switch
  let mod;
  try { mod = await import(`./views/${name}.mjs`); }
  catch (e) {
    if (myOp !== stageOp) return;
    stageHost.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>view module failed to load: ${e.message}</div></div>`;
    return;
  }
  if (myOp !== stageOp) return;
  const life = createViewLifecycle(mod, (e) => console.error(e));
  const el = document.createElement("div");
  el.style.height = "100%";
  stageHost.innerHTML = "";
  stageHost.append(el);
  stage = { name, life, el };
  try { await life.mounted(el, ctx); }
  catch (e) { el.innerHTML = `<div class="placeholder"><h2>${v?.title || name}</h2><div>mount failed: ${e.message}</div></div>`; }
}

function setNavActive(name) {
  for (const b of navEl.querySelectorAll(".nav-item")) b.classList.toggle("active", b.dataset.view === name);
}

function showTabLayer(on) {
  document.getElementById("tabhost").style.display = on ? "" : "none";
  if (!on) {
    stageHost.style.display = "";
    activeTab = null;
    for (const t of tabs.values()) t.tabEl.classList.remove("active");
  } else {
    stageHost.style.display = "none";
    setNavActive(null);
  }
}

// ── tabs ──────────────────────────────────────────────────────────────────
const tabbar = document.getElementById("tabbar");
const tabhost = document.getElementById("tabhost");
const tabs = new Map(); // id -> { tabEl, paneEl, title, key, onClose, onShow }
let nextTabId = 1;
let activeTab = null;

/** key: optional dedup key — activating an existing tab instead of opening a
 * twin. View modules keep module-level state (they are singletons by design),
 * so one tab per view/file is also a correctness requirement. Callers of a
 * KEYED open must `await whenKeyFree(key)` first: a reopen during a closed
 * tab's deferred cleanup queues behind it instead of being dropped or torn
 * down by the stale lifecycle. */
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
  showTabLayer(true);
  for (const [tid, t] of tabs) {
    t.tabEl.classList.toggle("active", tid === id);
    t.paneEl.classList.toggle("active", tid === id);
  }
  tabs.get(id)?.onShow?.();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  // onClose may return a promise (deferred cleanup while a mount is pending);
  // reserve the key until it resolves — reopen requests queue behind it via
  // whenKeyFree() instead of mounting under the stale lifecycle.
  try {
    const r = t.onClose?.();
    if (r && typeof r.then === "function" && t.key) reserveKey(t.key, r);
  } catch (e) { console.error(e); }
  t.tabEl.remove();
  t.paneEl.remove();
  tabs.delete(id);
  if (activeTab === id) {
    const rest = [...tabs.keys()];
    if (rest.length) activateTab(rest[rest.length - 1]);
    else { activeTab = null; showTabLayer(false); if (stage) setNavActive(stage.name); }
  }
}

// ── view host: load ./views/<name>.mjs, mount into a tab ─────────────────
async function openViewTab(name, title, extra = {}, key = `view:${name}`) {
  // A reopen during a closed tab's deferred cleanup queues here — never dropped.
  await whenKeyFree(key);
  let mod;
  try { mod = await import(`./views/${name}.mjs`); }
  catch (e) {
    const made = addTab({ title: `${title} (missing)`, key });
    if (made) made.paneEl.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>view module failed to load: ${e.message}</div></div>`;
    return;
  }
  const life = createViewLifecycle(mod, (e) => console.error(e));
  const made = addTab({
    title,
    key,
    // Close is safe at any time — including while the async mount is still
    // pending: the lifecycle defers cleanup until mount settles and then
    // runs THAT mount's disposer (never the module-wide unmount mid-flight,
    // which would clear every open mount of the module).
    onClose: () => life.close(),
  });
  if (!made) return; // existing tab activated
  const el = document.createElement("div");
  el.style.height = "100%";
  made.paneEl.append(el);
  try {
    await life.mounted(el, { ...ctx, ...extra });
  }
  catch (e) { el.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>mount failed: ${e.message}</div></div>`; }
}

// ── integrated terminal tab (the shell's own flagship view) ──────────────
const pendingTerms = new Set(); // keys reserved while a roster fetch is in flight
async function openTerminalTab(instance) {
  // Honor the views' workspace bus: an instance selected in a secondary
  // (server-advertised) workspace must resolve against THAT roster, and a
  // same-named instance in another workspace is a different terminal.
  const ws = currentWorkspace();
  const key = `term:${ws}:${instance}`;
  await whenKeyFree(key);
  for (const [tid, t] of tabs) if (t.key === key) { activateTab(tid); return; }
  if (pendingTerms.has(key)) return; // an open for this key is already in flight
  pendingTerms.add(key);
  try {
    await openTerminalTabInner(instance, ws, key);
  } finally {
    pendingTerms.delete(key);
  }
}

async function openTerminalTabInner(instance, ws, key) {
  // Resolve the tmux target from the roster of the selected workspace.
  const panel = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
  const inst = panel.instances.find((i) => i.instance === instance);
  if (!inst) return alert(`unknown instance "${instance}"`);
  if (!inst.running || !inst.tmux?.session) return alert(`"${instance}" has no live tmux session`);

  const wrap = document.createElement("div");
  wrap.className = "term-wrap";

  const term = new Terminal({
    fontSize: 13,
    fontFamily: "SF Mono, Menlo, monospace",
    theme: xtermTheme(),
    scrollback: 5000,
  });
  // live terminals follow the app theme (unsubscribed on tab close)
  const offTheme = onThemeChange(() => { term.options.theme = xtermTheme(); });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  // Composition (setup-inside-onReady, teardown symmetry) lives in
  // terminal-tab.mjs so its ordering is unit-testable (review termlc2).
  const tab = createTerminalTab({
    desk,
    term,
    tmux: { session: inst.tmux.session, window: inst.tmux.window },
    wrap,
    isActive: () => made.paneEl.classList.contains("active"),
    fit: () => fit.fit(),
  });

  const made = addTab({
    title: `⌗ ${instance}`,
    key,
    // close() resolves when cleanup (incl. a late-materializing pty detach)
    // actually ran — closeTab reserves the key on this promise.
    onClose: () => { offTheme(); return tab.close(); },
    onShow: () => { requestAnimationFrame(() => { try { fit.fit(); } catch {} }); },
  });
  if (!made) { offTheme(); term.dispose(); return; } // lost a race to an identical tab
  made.paneEl.append(wrap);
  term.open(wrap);
  fit.fit();

  await tab.start();
}

// ── nav rail ──────────────────────────────────────────────────────────────
// Three first-class surfaces (human directive): the agent hierarchy (home),
// souls browse+spawn, and agent brains — plus the instance transcript list.
// Diff and Jira surfaces are intentionally NOT wired (modules stay dormant
// in the tree per the coordinator's directive).
const NAV = [
  { name: "hierarchy", label: "Agents", icon: "⌘", title: "Agents" },
  { name: "instances", label: "Instances", icon: "◉", title: "Instances" },
  { name: "spawn", label: "Spawn", icon: "✚", title: "Spawn" },
  { name: "brain", label: "Brain", icon: "◈", title: "Agent brain" },
];
const navEl = document.getElementById("nav");
for (const v of NAV) {
  const b = document.createElement("button");
  b.className = "nav-item";
  b.title = v.title;
  b.dataset.view = v.name;
  b.innerHTML = `<span class="icon"></span><span class="label"></span>`;
  b.querySelector(".icon").textContent = v.icon;
  b.querySelector(".label").textContent = v.label;
  b.addEventListener("click", () => showStage(v.name));
  navEl.append(b);
}

// theme toggle at the bottom of the rail
{
  const foot = document.getElementById("nav-foot");
  const b = document.createElement("button");
  b.className = "nav-item";
  b.title = "Toggle light/dark theme";
  b.innerHTML = `<span class="icon">◐</span><span class="label">Theme</span>`;
  b.addEventListener("click", () => toggleTheme());
  (foot || navEl).append(b);
}

// ── command palette (⌘K): jump to an instance or run a command ───────────
const palette = createPalette({
  loadInstances: async () => {
    const ws = currentWorkspace();
    const p = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
    return p.instances || [];
  },
  openTerminal: (name) => openTerminalTab(name),
  commands: [
    { label: "View: Agents (hierarchy)", run: () => showStage("hierarchy") },
    { label: "View: Instances", run: () => showStage("instances") },
    { label: "View: Spawn an agent", run: () => showStage("spawn") },
    { label: "View: Agent brain", run: () => showStage("brain") },
    { label: "Theme: toggle light/dark", run: () => toggleTheme() },
  ],
});
window.addEventListener("keydown", (e) => {
  // ⌘K / Ctrl-K opens the palette — but NEVER while a terminal pane has
  // focus with Ctrl (Ctrl-K belongs to the shell running in tmux; Cmd-K is
  // safe — macOS never forwards Cmd chords to the pty).
  if (e.key.toLowerCase() === "k" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    palette.toggle();
  }
});

document.getElementById("ws-name").textContent = "";
api("/api/panel").then((p) => {
  document.getElementById("ws-name").textContent = p.workspace?.name ? `· ${p.workspace.name}` : "";
}).catch(() => {});

// Home surface: the agent hierarchy — running instances and how they relate.
showStage("hierarchy");
