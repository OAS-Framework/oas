// OAS desktop — renderer shell: nav rail + tabbed view host.
//
// View contract (binding, from the desktop-app contract): each view is an ES
// module in ./views/ exporting mount(el, ctx) / unmount(), where
//   ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }
// The shell owns tabs/navigation and provides ctx. The full roster (with
// chat transcript, spawn, jira) lives in the ported views — the shell chrome
// stays a thin rail so nothing is duplicated.
import { currentWorkspace, groupInstances, adoptWorkspace, onWorkspaceChange } from "./views/common.mjs";
import {
  initTheme, toggleTheme, xtermTheme, onThemeChange,
  terminalTypography, setTerminalFontSize, setTerminalFontFamily, onTerminalTypographyChange,
} from "./theme.mjs";
import { createPalette, isPaletteShortcut } from "./palette.mjs";
import { createViewLifecycle } from "./view-lifecycle.mjs";
import { reserveKey, whenKeyFree } from "./tab-keys.mjs";
import { createTerminalTab } from "./terminal-tab.mjs";
import { createTabChrome, tabKeyAction, focusAfterLastTab } from "./tab-a11y.mjs";
import { createIntentGate, prepareOwnedOpen } from "./open-intent.mjs";
import { createWorkspaceLabel } from "./workspace-label.mjs";
import {
  collapseKey, hasInstanceChildren, instanceRepoLabel, treeGuideSegments, filterInstanceTree, instanceVisibleInTree,
  captureTreeRenderState, configureDisclosure, rosterResponseOwns,
} from "./instance-tree.mjs";
import {
  terminalTabsForWorkspace, tabVisibleInContext, canActivateTab,
  fallbackTabForContext, terminalOpenOwnsWorkspace,
} from "./workspace-tabs.mjs";

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
  openBrain: (agent) => openBrainTab(agent),
  // additive shell affordance (views feature-detect it): switch the STAGE
  // to a named sidebar view (stage views are not tabs — see below).
  openView: (name) => name === "instances"
    ? contextRosterEl?.querySelector(".ctx-filter")?.focus()
    : showStage(name),
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
  setSidebarMode(name === "spawn" ? "souls" : "overview");
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
  tabbar.style.display = on ? "" : "none";
  if (!on) {
    stageHost.style.display = "";
    activeTab = null;
    for (const t of tabs.values()) {
      t.tabEl.classList.remove("active");
      t.triggerEl.setAttribute("aria-selected", "false");
      t.triggerEl.tabIndex = -1;
      t.paneEl.hidden = true;
    }
  } else {
    stageHost.style.display = "none";
    updateContextTabs();
  }
}

function updateContextTabs() {
  for (const t of tabs.values()) {
    const visible = tabVisibleInContext(t, sidebarMode, currentWorkspace());
    t.tabEl.hidden = !visible;
  }
}

// ── one contextual sidebar: nav + recursive instance roster ─────────────
let sidebarMode = "overview";
let contextRosterGen = 0;
let contextRosterEl = null;
let contextFilter = "";
let contextInstances = [];
let contextWorkspace = "";
const collapsedInstances = new Set();
const workspaceLabel = createWorkspaceLabel(document.getElementById("ws-name"));

function initContextRoster() {
  contextRosterEl = document.getElementById("instance-roster");
  const input = contextRosterEl.querySelector(".ctx-filter");
  input.addEventListener("input", (e) => {
    contextFilter = e.target.value.toLowerCase();
    renderContextRoster(contextInstances);
  });
  refreshContextRoster();
}

function setSidebarMode(mode) {
  sidebarMode = mode;
  if (typeof tabs !== "undefined") updateContextTabs();
}

async function refreshContextRoster() {
  if (!contextRosterEl) return;
  const myGen = ++contextRosterGen;
  const commitWorkspaceLabel = workspaceLabel.begin();
  const ws = currentWorkspace();
  const owns = (responseWs = ws) => rosterResponseOwns({
    dispatchWorkspace: ws,
    responseWorkspace: responseWs,
    currentWorkspace: currentWorkspace(),
    dispatchGeneration: myGen,
    currentGeneration: contextRosterGen,
  });
  const listEl = contextRosterEl.querySelector(".ctx-list");
  let panel;
  try {
    panel = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
  } catch (e) {
    if (owns()) listEl.innerHTML = `<div class="ctx-empty">Roster unavailable: ${e.message}</div>`;
    return;
  }
  const resolvedWs = panel.workspace?.id || ws;
  if (!owns(resolvedWs)) return;
  if (!currentWorkspace() && resolvedWs) adoptWorkspace(resolvedWs);
  commitWorkspaceLabel(panel.workspace);
  contextWorkspace = resolvedWs;
  contextInstances = panel.instances || [];
  renderContextRoster(contextInstances);
}

function renderContextRoster(instances) {
  const listEl = contextRosterEl.querySelector(".ctx-list");
  const restoreTreeState = captureTreeRenderState(listEl);
  listEl.innerHTML = "";
  const matching = filterInstanceTree(instances, contextFilter);
  const ws = contextWorkspace || currentWorkspace();
  const filtering = !!contextFilter.trim();
  const visible = matching.filter((i) => instanceVisibleInTree(
    i, instances, collapsedInstances, ws, filtering,
  ));
  contextRosterEl.querySelector(".ctx-count").textContent = `${instances.filter((i) => i.running).length}/${instances.length}`;
  if (!visible.length) {
    listEl.innerHTML = `<div class="ctx-empty">${instances.length ? "Nothing matches." : "No instances."}</div>`;
    restoreTreeState();
    return;
  }
  for (const [, repos] of groupInstances(visible)) {
    for (const [repo, items] of repos) {
      const rh = document.createElement("div");
      rh.className = "ctx-repo";
      rh.textContent = repo;
      listEl.append(rh);
      for (const i of items) {
        const rowWrap = document.createElement("div");
        rowWrap.className = "ctx-tree-row";
        rowWrap.style.setProperty("--depth", String(i.depth || 0));
        const activeKey = tabs.get(activeTab)?.key;
        const isActive = activeKey === `term:${ws}:${i.instance}`;
        const key = collapseKey(ws, i.instance);
        const hasChildren = hasInstanceChildren(instances, i.instance);
        const collapsed = collapsedInstances.has(key);

        // VS Code-style ancestry guides: exhausted ancestor branches vanish;
        // the final sibling stops at its elbow instead of implying another row.
        const guides = document.createElement("span");
        guides.className = "ctx-guides";
        treeGuideSegments(items, i).forEach((segment, d) => {
          if (segment === "none") return;
          const guide = document.createElement("span");
          guide.className = `ctx-guide ${segment}`;
          guide.style.left = `${10 + d * 14}px`;
          guides.append(guide);
        });
        const disclosure = document.createElement("button");
        disclosure.type = "button";
        disclosure.className = `ctx-disclosure${hasChildren ? "" : " empty"}`;
        disclosure.tabIndex = hasChildren ? 0 : -1;
        if (hasChildren) {
          configureDisclosure(disclosure, {
            instance: i.instance, collapsed, filtering,
            onToggle: () => {
              if (collapsed) collapsedInstances.delete(key); else collapsedInstances.add(key);
              renderContextRoster(contextInstances);
            },
          });
        } else {
          disclosure.textContent = "▾";
          disclosure.setAttribute("aria-hidden", "true");
        }

        const row = document.createElement("button");
        row.type = "button";
        row.dataset.treeInstance = i.instance;
        row.dataset.treeControl = "terminal";
        row.className = "ctx-inst" + (i.running ? "" : " idle") + (isActive ? " active" : "");
        row.disabled = !i.running;
        row.title = i.running ? `Open ${i.instance} terminal` : `${i.instance} is idle`;
        const dot = document.createElement("span");
        dot.className = `ctx-dot ${i.running ? "on" : "off"}`;
        const copy = document.createElement("span");
        copy.className = "ctx-copy";
        const name = document.createElement("span");
        name.className = "ctx-name";
        name.textContent = i.instance;
        const meta = document.createElement("span");
        meta.className = "ctx-meta ctx-repo-label";
        meta.textContent = instanceRepoLabel(i);
        meta.title = `Repository: ${meta.textContent}`;
        copy.append(name, meta);
        row.append(dot, copy);
        row.addEventListener("click", () => openTerminalTab(i.instance));
        rowWrap.append(guides, disclosure, row);
        listEl.append(rowWrap);
      }
    }
  }
  restoreTreeState();
}

function showTerminalContext() {
  setSidebarMode("instances");
  refreshContextRoster();
  const openTerms = terminalTabsForWorkspace(tabs, currentWorkspace());
  if (openTerms.length) { activateTab(openTerms.at(-1)[0]); return; }
  // With the tree permanently visible there is no standalone Instances stage.
  // Closing/switching away from the last terminal restores the prior surface.
  setSidebarMode(stage?.name === "spawn" ? "souls" : "overview");
  showTabLayer(false);
  setNavActive(stage?.name || "hierarchy");
}

// ── tabs ──────────────────────────────────────────────────────────────────
const tabbar = document.getElementById("tabbar");
const tabhost = document.getElementById("tabhost");
const tabs = new Map(); // id -> { tabEl, triggerEl, closeEl, paneEl, title, key, onClose, onShow }
let nextTabId = 1;
let activeTab = null;
const brainIntents = createIntentGate();

/** key: optional dedup key — activating an existing tab instead of opening a
 * twin. View modules keep module-level state (they are singletons by design),
 * so one tab per view/file is also a correctness requirement. Callers of a
 * KEYED open must `await whenKeyFree(key)` first: a reopen during a closed
 * tab's deferred cleanup queues behind it instead of being dropped or torn
 * down by the stale lifecycle. */
function onTabKeydown(e, id) {
  const visible = [...tabs].filter(([, t]) => !t.tabEl.hidden);
  const at = visible.findIndex(([tid]) => tid === id);
  if (at < 0) return;
  const action = tabKeyAction(e, at, visible.length);
  if (!action) return;
  e.preventDefault();
  if (action.type === "close") { closeTab(id, true); return; }
  const [nextId, tab] = visible[action.index];
  if (activateTab(nextId)) tab.triggerEl.focus();
}

function addTab({ title, key, kind = "artifact", workspace = null, onClose, onShow }) {
  if (key) {
    for (const [tid, t] of tabs) if (t.key === key) { activateTab(tid); return null; }
  }
  const id = nextTabId++;
  const { tabEl, triggerEl, closeEl, paneEl } = createTabChrome(
    document, id, title, navigator.platform.includes("Mac"),
  );
  tabbar.append(tabEl);
  tabhost.append(paneEl);
  triggerEl.addEventListener("click", () => activateTab(id));
  triggerEl.addEventListener("keydown", (e) => onTabKeydown(e, id));
  closeEl.addEventListener("click", (e) => { e.stopPropagation(); closeTab(id, true); });
  tabs.set(id, { tabEl, triggerEl, closeEl, paneEl, title, key, kind, workspace, onClose, onShow });
  activateTab(id);
  return { id, paneEl };
}

function activateTab(id) {
  const current = tabs.get(id);
  // Hidden is not security: reject cross-workspace terminal activation at
  // the mutation boundary before its pane can become active/receive input.
  if (!canActivateTab(current, currentWorkspace())) return false;
  activeTab = id;
  if (current?.kind === "terminal") {
    setSidebarMode("instances");
    setNavActive(null);
    refreshContextRoster();
  } else if (current?.kind === "brain") {
    setSidebarMode("souls");
    setNavActive("spawn");
  }
  showTabLayer(true);
  for (const [tid, t] of tabs) {
    const selected = tid === id;
    t.tabEl.classList.toggle("active", selected);
    t.triggerEl.setAttribute("aria-selected", String(selected));
    t.triggerEl.tabIndex = selected ? 0 : -1;
    t.paneEl.classList.toggle("active", selected);
    t.paneEl.hidden = !selected;
  }
  tabs.get(id)?.onShow?.();
  return true;
}

function closeTab(id, restoreFocus = false) {
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
    const fallback = fallbackTabForContext(tabs, sidebarMode, currentWorkspace());
    if (fallback) {
      activateTab(fallback[0]);
      if (restoreFocus) fallback[1].triggerEl.focus();
    } else if (t.kind === "terminal") {
      showTerminalContext();
      if (restoreFocus) focusAfterLastTab("terminal", {
        instancesEntry: contextRosterEl?.querySelector(".ctx-filter"),
      });
    } else {
      activeTab = null;
      showTabLayer(false);
      if (stage) setNavActive(stage.name);
      if (restoreFocus) focusAfterLastTab("artifact", {
        stageEntry: navEl.querySelector(".nav-item.active") || navEl.querySelector(".nav-item"),
      });
    }
  } else if (restoreFocus) {
    tabs.get(activeTab)?.triggerEl.focus();
  }
}

// ── view host: load ./views/<name>.mjs, mount into a tab ─────────────────
async function openBrainTab(agent) {
  // brain.mjs is intentionally one live mount. Each click supersedes every
  // earlier async open BEFORE waiting for deferred cleanup/module loading.
  const owns = brainIntents.begin();
  for (const [id, t] of tabs) if (t.kind === "brain") closeTab(id);
  return openViewTab("brain", `◈ ${agent}`, { agent }, "view:brain", "brain", owns);
}

async function openViewTab(name, title, extra = {}, key = `view:${name}`,
  kind = name === "markdown" ? "file" : "artifact", owns = () => true) {
  let mod;
  try {
    mod = await prepareOwnedOpen({
      owns,
      waitForKey: () => whenKeyFree(key),
      load: () => import(`./views/${name}.mjs`),
    });
    if (!mod) return;
  } catch (e) {
    if (!owns()) return;
    const made = addTab({ title: `${title} (missing)`, key });
    if (made) made.paneEl.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>view module failed to load: ${e.message}</div></div>`;
    return;
  }
  const life = createViewLifecycle(mod, (e) => console.error(e));
  const made = addTab({
    title,
    key,
    kind,
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
    if (!owns()) return;
  }
  catch (e) {
    if (owns()) el.innerHTML = `<div class="placeholder"><h2>${name}</h2><div>mount failed: ${e.message}</div></div>`;
  }
}

// ── integrated terminal tab (the shell's own flagship view) ──────────────
const pendingTerms = new Set(); // keys reserved while a roster fetch is in flight
async function openTerminalTab(instance) {
  // A tree selection opens its terminal directly; there is no standalone
  // Instances destination now that the persistent roster is always present.
  setSidebarMode("instances");
  setNavActive(null);
  refreshContextRoster();
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
  const owns = () => terminalOpenOwnsWorkspace(ws, currentWorkspace());
  let panel;
  try {
    panel = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
  } catch (e) {
    if (!owns()) return; // stale rejection belongs to the old workspace
    throw e;
  }
  // Workspace changed while /api/panel was in flight: discard BEFORE addTab
  // (addTab auto-activates, so a late A open could otherwise receive B input).
  if (!owns()) return;
  const inst = panel.instances.find((i) => i.instance === instance);
  if (!inst) return alert(`unknown instance "${instance}"`);
  if (!inst.running || !inst.tmux?.session) return alert(`"${instance}" has no live tmux session`);

  const wrap = document.createElement("div");
  wrap.className = "term-wrap";

  const type = terminalTypography();
  const term = new Terminal({
    fontSize: type.fontSize,
    fontFamily: type.fontFamily,
    theme: xtermTheme(),
    scrollback: 5000,
  });
  // live terminals follow app theme + persisted typography preferences
  const offTheme = onThemeChange(() => { term.options.theme = xtermTheme(); });
  const offTypography = onTerminalTypographyChange((next) => {
    term.options.fontFamily = next.fontFamily;
    term.options.fontSize = next.fontSize;
    requestAnimationFrame(() => { try { fit.fit(); } catch {} });
  });
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
    kind: "terminal",
    workspace: ws,
    // close() resolves when cleanup (incl. a late-materializing pty detach)
    // actually ran — closeTab reserves the key on this promise.
    onClose: () => { offTheme(); offTypography(); return tab.close(); },
    onShow: () => { requestAnimationFrame(() => { try { fit.fit(); } catch {} }); },
  });
  if (!made) { offTheme(); offTypography(); term.dispose(); return; } // lost a race to an identical tab
  made.paneEl.append(wrap);
  term.open(wrap);
  fit.fit();

  await tab.start();
}

// ── nav rail ──────────────────────────────────────────────────────────────
// Two first-class navigation surfaces: hierarchy and soul roster. Instances
// live permanently below them; selecting one opens its terminal artifact.
// Diff and Jira surfaces are intentionally NOT wired (modules stay dormant
// in the tree per the coordinator's directive).
const NAV = [
  { name: "hierarchy", label: "Active overview", icon: "⌘", title: "Active overview" },
  { name: "spawn", label: "Soul roster", icon: "✦", title: "Soul roster" },
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
    { label: "View: Active overview", run: () => showStage("hierarchy") },
    { label: "View: Soul roster", run: () => showStage("spawn") },
    { label: "Theme: toggle light/dark", run: () => toggleTheme() },
    { label: "Terminal: increase font size", run: () => setTerminalFontSize(terminalTypography().fontSize + 1) },
    { label: "Terminal: decrease font size", run: () => setTerminalFontSize(terminalTypography().fontSize - 1) },
    { label: "Terminal: set font family…", run: () => {
      const current = terminalTypography().fontFamily;
      const next = window.prompt("Terminal font family (CSS font-family value)", current);
      if (next !== null) setTerminalFontFamily(next);
    } },
    { label: "Terminal: reset typography", run: () => { setTerminalFontFamily(""); setTerminalFontSize(13); } },
  ],
});
window.addEventListener("keydown", (e) => {
  const insideTerminal = !!e.target?.closest?.(".xterm");
  if (isPaletteShortcut(e, insideTerminal)) {
    e.preventDefault();
    palette.toggle();
  }
});

// Persistent recursive instance tree: always available below the three nav
// surfaces, with no second/contextual sidebar and no width jump.
initContextRoster();
onWorkspaceChange(() => {
  contextRosterGen++;
  brainIntents.invalidate();
  workspaceLabel.reset();
  contextInstances = [];
  contextWorkspace = currentWorkspace();
  updateContextTabs();
  if (sidebarMode === "instances") showTerminalContext();
  else refreshContextRoster();
});
setInterval(() => refreshContextRoster(), 4000);

// Home surface: the agent hierarchy — running instances and how they relate.
showStage("hierarchy");
