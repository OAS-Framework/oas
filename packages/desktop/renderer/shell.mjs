// OAS desktop — renderer shell: nav rail + tabbed view host.
//
// View contract (binding, from the desktop-app contract): each view is an ES
// module in ./views/ exporting mount(el, ctx) / unmount(), where
//   ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }
// The shell owns tabs/navigation and provides ctx. The full functionality
// (hierarchy, spawn, brain, markdown) lives in the ported views — the shell
// chrome stays a thin rail so nothing is duplicated.
// (groupInstances is not imported here: the feature branch renders the
// sidebar roster via clusterInstances — lineage clusters with identity keys.)
import { currentWorkspace, setWorkspace, adoptWorkspace, onWorkspaceChange, httpError } from "./views/common.mjs";
import {
  initTheme, toggleTheme, xtermTheme, onThemeChange,
  terminalTypography, setTerminalFontSize, setTerminalFontFamily, onTerminalTypographyChange,
} from "./theme.mjs";
import { createPalette } from "./palette.mjs";
import { createQuickOpen } from "./quick-open.mjs";
import {
  registerAction, setActiveContexts, getBinding, onKeymapChange, formatChord, handleKeydown, matchEvent,
} from "./keybindings.mjs";
import { createKeybindingsEditor } from "./keybindings-editor.mjs";
import { rosterKeyAction, moveTarget } from "./roster-keys.mjs";
import { createViewLifecycle } from "./view-lifecycle.mjs";
import { reserveKey, whenKeyFree } from "./tab-keys.mjs";
import { createTerminalTab, terminalOptions } from "./terminal-tab.mjs";
import { createTabChrome, tabKeyAction, focusAfterLastTab } from "./tab-a11y.mjs";
import { createIntentGate, prepareOwnedOpen, runOpenFlow } from "./open-intent.mjs";
import { createWorkspaceSwitcher } from "./workspace-switcher.mjs";
import { NAV, stageSidebarMode, loadStageView } from "./shell-nav.mjs";
import {
  collapseKey, hasInstanceChildren, instanceRepoLabel, treeGuideSegments, filterInstanceTree, instanceVisibleInTree,
  captureTreeRenderState, configureDisclosure, rosterResponseOwns, clusterSeparator,
  instanceId, rosterParentId, terminalKey, resolveTerminalOpen, visibleClusters,
} from "./instance-tree.mjs";
import {
  tabVisibleInContext, canActivateTab,
  fallbackTabForContext, terminalOpenOwnsWorkspace, restoreTerminalTab,
} from "./workspace-tabs.mjs";
import { requestSplit, absorbTab, removeSplitTab, isSplitMember, adjacentSplitMember, wireSplitPaneSelection } from "./split-layout.mjs";

const desk = window.oasDesktop;
initTheme();

// ── ctx (shared by all views) ─────────────────────────────────────────────
async function api(pathname, opts) {
  const r = await desk.api(pathname, opts);
  if (!r.ok) throw httpError(r, pathname);
  return r.body;
}

const ctx = {
  api,
  openFile: (path) => openViewTab("markdown", `≡ ${String(path).split("/").pop()}`, { path }, `file:${path}`),
  openTerminal: (instance, opts) => openTerminalTab(instance, opts),
  openBrain: (agent) => openBrainTab(agent),
  // CLI degradation affordances (cli-status.mjs feature-detects both):
  // native binary picker (privileged; main persists the choice) and external
  // link opening (window.open is denied by the shell's window-open handler
  // except for http(s), which routes to the OS browser).
  chooseCliBinary: () => desk.cliPickBinary(),
  openExternal: (url) => window.open(url, "_blank", "noreferrer"),
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
  setSidebarMode(stageSidebarMode(name));
  setNavActive(name);
  showTabLayer(false);
  if (stage && stage.name === name) return;   // already on this surface
  const myOp = ++stageOp;
  const prev = stage;
  stage = null;
  if (prev) { try { await prev.life.close(); } catch (e) { console.error(e); } prev.el.remove(); }
  if (myOp !== stageOp) return;               // superseded by a faster switch
  let mod;
  try { mod = await loadStageView(name); }
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
  // Re-derive contexts from the CURRENT layer state: the user may have
  // activated a tab while this stage was loading — a late mount completion
  // must not replace the live "tabs" context with a hidden stage context.
  updateActiveContexts();
  try { await life.mounted(el, ctx); }
  catch (e) { el.innerHTML = `<div class="placeholder"><h2>${v?.title || name}</h2><div>mount failed: ${e.message}</div></div>`; }
}

function setNavActive(name) {
  for (const b of navEl.querySelectorAll(".nav-item")) b.classList.toggle("active", b.dataset.view === name);
}

function showTabLayer(on) {
  document.getElementById("tabhost").style.display = on ? "" : "none";
  tabbar.style.display = on ? "" : "none";
  updateActiveContexts(on);
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
const desktopBridge = window.oasDesktop;
const unavailableWorkspaceService = () => Promise.reject(new Error("Workspace discovery is not available in this desktop service yet."));
const workspaceLabel = createWorkspaceSwitcher({
  document,
  selectWorkspace: setWorkspace,
  // Feature-detected while tui-dev lands the approved privileged contract.
  // The final adapter names are intentionally isolated to these three lines.
  discoverSuggestions: desktopBridge.workspaceSuggestions || unavailableWorkspaceService,
  addWorkspace: desktopBridge.workspaceAdd || unavailableWorkspaceService,
  pickWorkspace: desktopBridge.workspacePick || unavailableWorkspaceService,
});

// ── keybinding contexts ──────────────────────────────────────────────────────────
// The engine dispatches an action only when its context is active. "tabs"
// is live while the tab layer covers the stage; "stage:<name>" while that
// stage is the visible surface. Views register their own view-local actions
// (context stage:<name>) in mount and dispose them in unmount.
let tabLayerVisible = false;
function updateActiveContexts(tabLayerOn = tabLayerVisible) {
  tabLayerVisible = tabLayerOn;
  const set = new Set();
  if (tabLayerOn) set.add("tabs");
  else if (stage) set.add(`stage:${stage.name}`);
  setActiveContexts(set);
}

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
  commitWorkspaceLabel(panel.workspace, panel.workspaces);
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
  // Sidebar groups by agent CLUSTER (connected relations), not per repo:
  // the repo is the small label under each instance. Clusters read purely
  // from SPACING/STRUCTURE (human re-test: no visible glyph) — multi-member
  // clusters get an invisible separator that still exposes the group
  // boundary to AT (role=separator + aria-label); single-node clusters get
  // nothing. Clusters are computed on the FULL roster then projected to
  // visible members — clustering a filtered subset could forge edges from
  // globally ambiguous names (merged-state review @3e76616).
  for (const cluster of visibleClusters(instances, visible)) {
    const items = cluster.instances;
    if (items.length > 1) {
      listEl.append(clusterSeparator(document, items.length));
    }
    {
      for (const i of items) {
        const rowWrap = document.createElement("div");
        rowWrap.className = "ctx-tree-row";
        rowWrap.style.setProperty("--depth", String(i.depth || 0));
        const activeKey = tabs.get(activeTab)?.key;
        const isActive = activeKey === terminalKey(ws, i);
        // Collapse and focus state key by IDENTITY, not bare name: two
        // same-named instances from different agents roots collapse and
        // focus independently (review 46f3fdc).
        const key = collapseKey(ws, instanceId(i));
        const hasChildren = hasInstanceChildren(instances, i);
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
            instance: instanceId(i), label: i.instance, collapsed, filtering,
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
        row.dataset.treeInstance = instanceId(i);
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
        // pass the FULL reference: same-named instances in other agents
        // roots must open THEIR tmux session, not the first name match
        row.addEventListener("click", () => openTerminalTab({ instance: i.instance, home: i.home, agentsRoot: i.agentsRoot }));
        // full keyboard tree operability (roving tabindex; policy in
        // roster-keys.mjs). Enter is the button's native activation.
        row.dataset.rosterChildren = hasChildren ? "1" : "0";
        row.dataset.rosterCollapsed = collapsed ? "1" : "0";
        row.tabIndex = -1;
        row.addEventListener("keydown", onRosterRowKey);
        rowWrap.append(guides, disclosure, row);
        listEl.append(rowWrap);
      }
    }
  }
  restoreTreeState();
  // roving tabindex: exactly one row enters the tab order — the focused row
  // when it survived the rebuild, else the first enabled one
  const rowsAfter = [...listEl.querySelectorAll(".ctx-inst")];
  const focusedRow = rowsAfter.find((r) => r === listEl.ownerDocument.activeElement);
  const tabbable = focusedRow || rowsAfter.find((r) => !r.disabled);
  if (tabbable) tabbable.tabIndex = 0;
}

/* Keyboard walk over the rendered roster rows. Disabled (idle) rows stay
   visible but focus skips them; expanding/collapsing re-renders and the
   focused instance is restored by captureTreeRenderState. */
function onRosterRowKey(e) {
  const btn = e.currentTarget;
  const action = rosterKeyAction(e, {
    hasChildren: btn.dataset.rosterChildren === "1",
    collapsed: btn.dataset.rosterCollapsed === "1",
  });
  if (!action) return;
  e.preventDefault();
  const listEl = contextRosterEl.querySelector(".ctx-list");
  const rows = [...listEl.querySelectorAll(".ctx-inst")];
  const at = rows.indexOf(btn);
  const id = btn.dataset.treeInstance; // instanceId(i) — composite identity
  const ws = contextWorkspace || currentWorkspace();
  const focusInstance = (targetId) => {
    const target = [...listEl.querySelectorAll(".ctx-inst")]
      .find((r) => r.dataset.treeInstance === targetId && !r.disabled);
    if (target) setRovingRow(listEl, target);
    return !!target;
  };
  if (action.type === "expand" || action.type === "collapse") {
    const key = collapseKey(ws, id);
    if (action.type === "expand") collapsedInstances.delete(key); else collapsedInstances.add(key);
    renderContextRoster(contextInstances);
    focusInstance(id);
    return;
  }
  if (action.type === "parent") {
    // rows carry instanceId, so resolve the CURRENT item and its parent by
    // IDENTITY — a bare-name lookup never matches identity-bearing rows
    // (ArrowLeft dead) and is unsafe for duplicate names (review 96b037b)
    const pid = rosterParentId(contextInstances, id);
    if (pid) focusInstance(pid);
    return;
  }
  const to = moveTarget(action, at, rows.length);
  if (to < 0 || to === at) return;
  // skip idle (disabled) rows: delta moves keep travelling in their
  // direction; Home/End jumps fall back inward toward the focused row.
  const step = action.to ? (to > at ? -1 : 1) : (to > at ? 1 : -1);
  let cursor = to;
  while (cursor >= 0 && cursor < rows.length && cursor !== at && rows[cursor].disabled) cursor += step;
  if (cursor >= 0 && cursor < rows.length && cursor !== at && !rows[cursor].disabled) setRovingRow(listEl, rows[cursor]);
}

/* Move focus AND the single tab-order slot to `row` (roving tabindex). */
function setRovingRow(listEl, row) {
  for (const r of listEl.querySelectorAll('.ctx-inst[tabindex="0"]')) r.tabIndex = -1;
  row.tabIndex = 0;
  row.focus();
}

function showTerminalContext() {
  setSidebarMode("instances");
  refreshContextRoster();
  // Per-workspace active-tab memory: switching back to a workspace restores
  // the terminal that was active there (stale/foreign keys fall back to the
  // most recently opened terminal of the workspace).
  const ws = currentWorkspace();
  const restored = restoreTerminalTab(tabs, ws, wsActiveTerminal.get(ws));
  if (restored) { activateTab(restored[0]); return; }
  // With the tree permanently visible, closing/switching away from the last
  // terminal restores the prior stage surface.
  setSidebarMode(stageSidebarMode(stage?.name));
  showTabLayer(false);
  setNavActive(stage?.name || "hierarchy");
}

// ── tabs ──────────────────────────────────────────────────────────────────
const tabbar = document.getElementById("tabbar");
const tabhost = document.getElementById("tabhost");
const tabs = new Map(); // id -> { tabEl, triggerEl, closeEl, paneEl, title, key, onClose, onShow }
let nextTabId = 1;
let activeTab = null;
const wsActiveTerminal = new Map(); // workspace id -> last-active terminal tab key
const brainIntents = createIntentGate();

// ── split panes: several terminal tabs shown at once in #tabhost ────────
// Pure transitions live in split-layout.mjs; the shell owns the DOM: member
// panes become flex cells of #tabhost (orientation row = side-by-side,
// col = stacked); an empty slot shows a placeholder until the NEXT terminal
// tab is opened/activated — splits host tabs, so identity resolution and
// dedup stay exactly the tab path's. Terminal FitAddon refit is automatic:
// each tab's ResizeObserver fires when its pane is resized by the layout.
let split = null; // { orientation, members: [tabId], pending } | null
const splitEmptyEl = (() => {
  const el = document.createElement("div");
  el.className = "split-empty";
  el.setAttribute("role", "note");
  el.textContent = "Select an instance from the sidebar (or the palette) to fill this pane";
  return el;
})();

function renderSplit(splitVisible) {
  const on = splitVisible && !!split;
  tabhost.classList.toggle("split-row", on && split.orientation === "row");
  tabhost.classList.toggle("split-col", on && split.orientation === "col");
  if (!on) { splitEmptyEl.remove(); return; }
  // Append only when the pane is out of position: re-inserting an
  // already-placed node would tear it out of the DOM mid-interaction
  // (pane-click selection fires activateTab → renderSplit on pointerdown).
  let anchor = null; // last correctly-placed element
  for (const id of split.members) {
    const t = tabs.get(id);
    if (!t) continue;
    const inPlace = t.paneEl.parentNode === tabhost && (anchor ? anchor.nextSibling === t.paneEl : true);
    if (!inPlace) {
      if (anchor) anchor.after(t.paneEl); else tabhost.append(t.paneEl);
    }
    anchor = t.paneEl;
  }
  if (split.pending > 0) {
    if (splitEmptyEl.previousSibling !== anchor || splitEmptyEl.parentNode !== tabhost) {
      if (anchor) anchor.after(splitEmptyEl); else tabhost.append(splitEmptyEl);
    }
  } else splitEmptyEl.remove();
}

function splitPane(orientation) {
  const t = tabs.get(activeTab);
  if (!t || t.kind !== "terminal") return; // splits are terminal-only
  const r = requestSplit(split, orientation, activeTab);
  split = r.split;
  if (!r.changed) return;
  activateTab(activeTab);
  // the empty slot is filled by picking an instance — take the user there
  if (split?.pending > 0) focusRoster();
}

function closeSplit() {
  if (!split) return;
  split = null;
  if (activeTab != null) activateTab(activeTab);
}

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

function addTab({ title, key, kind = "artifact", workspace = null, onClose, onShow, focusContent = null, focusOnActivate = false }) {
  if (key) {
    for (const [tid, t] of tabs) if (t.key === key) { activateTab(tid, { focusContent: focusOnActivate }); return null; }
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
  // Split panes: clicking or focusing INTO a visible non-selected member
  // pane selects its tab (without moving DOM focus — activateTab never
  // focuses itself; focusContent stays a user-initiated jump), so
  // tabs.close / further splits target the terminal the user is actually
  // interacting with.
  wireSplitPaneSelection(paneEl, {
    isMember: () => isSplitMember(split, id),
    isActive: () => activeTab === id,
    select: () => activateTab(id),
  });
  tabs.set(id, { tabEl, triggerEl, closeEl, paneEl, title, key, kind, workspace, onClose, onShow, focusContent });
  activateTab(id);
  return { id, paneEl };
}

/** Activate a tab. opts.focusContent distinguishes USER-INITIATED jumps
 * (palette instance jump, roster row Enter/click, quick-open) — which end
 * with the tab's content focused (a terminal's xterm textarea, via the
 * tab's focusContent callback) — from side-effect activations (workspace-
 * switch restoration, close-fallback), which must NOT steal focus. */
function activateTab(id, { focusContent = false } = {}) {
  const current = tabs.get(id);
  // Hidden is not security: reject cross-workspace terminal activation at
  // the mutation boundary before its pane can become active/receive input.
  if (!canActivateTab(current, currentWorkspace())) return false;
  activeTab = id;
  if (current?.kind === "terminal") {
    // a pending split slot absorbs the next terminal tab the user lands on
    split = absorbTab(split, id).split;
  }
  if (current?.kind === "terminal" && current.workspace) {
    wsActiveTerminal.set(current.workspace, current.key);
  }
  if (current?.kind === "terminal") {
    setSidebarMode("instances");
    setNavActive(null);
    refreshContextRoster();
  } else if (current?.kind === "brain") {
    setSidebarMode("souls");
    setNavActive("spawn");
  }
  showTabLayer(true);
  // Split panes stay visible only while the ACTIVE tab is a member —
  // activating a non-member (file/brain/other terminal) covers the split.
  const splitVisible = isSplitMember(split, id);
  for (const [tid, t] of tabs) {
    const selected = tid === id;
    const inSplit = splitVisible && isSplitMember(split, tid);
    const shown = selected || inSplit;
    t.tabEl.classList.toggle("active", selected);
    t.triggerEl.setAttribute("aria-selected", String(selected));
    t.triggerEl.tabIndex = selected ? 0 : -1;
    t.paneEl.classList.toggle("active", shown);
    t.paneEl.classList.toggle("split-cell", inSplit);
    t.paneEl.hidden = !shown;
  }
  renderSplit(splitVisible);
  tabs.get(id)?.onShow?.();
  if (focusContent) tabs.get(id)?.focusContent?.();
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
  const wasSplitMember = isSplitMember(split, id);
  // Choose the successor BEFORE the split forgets the closed member: when
  // the ACTIVE member of a split closes, an adjacent surviving member must
  // win over the generic most-recent-tab fallback — otherwise an unrelated
  // newer terminal covers the split (merged-state review 156cbc7).
  const splitSuccessor = activeTab === id ? adjacentSplitMember(split, id) : null;
  split = removeSplitTab(split, id); // collapses to single-pane when < 2 remain
  if (activeTab === id) {
    if (splitSuccessor != null && tabs.has(splitSuccessor)) {
      activateTab(splitSuccessor);
      if (restoreFocus) tabs.get(splitSuccessor).triggerEl.focus();
      return;
    }
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
  // a member closed while another member stayed active: re-render the layout
  if (wasSplitMember && activeTab != null && activeTab !== id) activateTab(activeTab);
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
const pendingTerms = new Set(); // keys with a tab CREATION in flight (post-resolution — dedup for concurrent opens of one resolved identity)
/** ref: either a bare instance name (views, palette — resolved only when
 * unambiguous) or { instance, home?, agentsRoot? } (sidebar rows — exact).
 * opts.quiet (post-spawn auto-open): failures report via console.warn
 * instead of a blocking alert() — an automated handoff must never park a
 * modal dialog over the app; the user recovers from the sidebar roster.
 * ORDER MATTERS (review 7d740f9): the reference is resolved against the
 * roster FIRST and the dedup key derives from the RESOLVED instance, so a
 * bare-name open and a sidebar open of the same identity share one tab —
 * and an existing tab can never be activated for a name that has since
 * become ambiguous (resolution refuses before dedup can activate). */
async function openTerminalTab(ref, { quiet = false } = {}) {
  const notify = quiet ? (msg) => console.warn(`[terminal open] ${msg}`) : (msg) => alert(msg);
  // Quiet opens must NEVER reject either (review ff70e1c nit): the refusal
  // messages route through notify, but transport failures (the panel fetch,
  // the tab mount) would still escape as an unhandled rejection from an
  // automated caller that does not await. runOpenFlow catches every quiet
  // rejection into notify; interactive opens keep throwing.
  return runOpenFlow(() => openTerminalTabFlow(ref, notify), { quiet, notify });
}

async function openTerminalTabFlow(ref, notify) {
  // A sidebar-tree selection opens its terminal directly — the persistent
  // sidebar roster IS the instances surface (there is no Instances stage;
  // scope correction of PR #29).
  setSidebarMode("instances");
  setNavActive(null);
  refreshContextRoster();
  // Honor the views' workspace bus: an instance selected in a secondary
  // (server-advertised) workspace must resolve against THAT roster, and a
  // same-named instance in another workspace — or another agents root
  // (review 46f3fdc) — is a different terminal.
  const ws = currentWorkspace();
  const owns = () => terminalOpenOwnsWorkspace(ws, currentWorkspace());
  let panel;
  try {
    panel = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
  } catch (e) {
    if (!owns()) return; // stale rejection belongs to the old workspace
    throw e;
  }
  if (!owns()) return;
  // Identity-aware resolution BEFORE any key/tab decision (resolveTerminalOpen
  // encodes the ordering; review 7d740f9): an exact home/agentsRoot reference
  // finds ITS instance; a bare name resolves only when unambiguous — the
  // first same-named match could be another agents root's tmux session.
  const r = resolveTerminalOpen(panel.instances, ref, ws);
  if (r.error) {
    return notify(r.error === "ambiguous"
      ? `several instances are named "${r.name}" — open it from the sidebar tree, which addresses the exact one`
      : `unknown instance "${r.name}"`);
  }
  const { inst, key } = r;
  await whenKeyFree(key);
  // Every jump path through here is user-initiated (palette, roster row,
  // quick-open, post-spawn open) — activating an existing tab focuses its
  // terminal input so the user can type into tmux immediately.
  for (const [tid, t] of tabs) if (t.key === key) { activateTab(tid, { focusContent: true }); return; }
  if (pendingTerms.has(key)) return; // an open for this key is already in flight
  pendingTerms.add(key);
  try {
    await openTerminalTabInner(inst, ws, key, owns, notify);
  } finally {
    pendingTerms.delete(key);
  }
}

async function openTerminalTabInner(inst, ws, key, owns, notify = (msg) => alert(msg)) {
  // inst is the RESOLVED roster instance (openTerminalTab resolves + keys
  // before dedup; review 7d740f9). Re-check ownership here — whenKeyFree
  // may have waited across a workspace switch.
  if (!owns()) return;
  const name = inst.instance;
  if (!inst.running || !inst.tmux?.session) return notify(`"${name}" has no live tmux session`);

  const wrap = document.createElement("div");
  wrap.className = "term-wrap";

  const type = terminalTypography();
  const term = new Terminal(terminalOptions({
    fontSize: type.fontSize,
    fontFamily: type.fontFamily,
    theme: xtermTheme(),
  }));
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
    // Terminal-allowlisted shortcuts (engine policy: app.palette, tabs.*)
    // must be intercepted BEFORE xterm writes to the pty — its capture-phase
    // handler consumes e.g. Ctrl+K, so the bubble-phase window listener
    // never sees it. matchEvent applies the allowlist (insideTerminal);
    // the action runs once on keydown, and every phase of a matched chord
    // is claimed so no control byte leaks to the attached program.
    interceptKey: (ev) => {
      if (!matchEvent(ev, { insideTerminal: true })) return false;
      if (ev.type === "keydown") handleKeydown(ev, { insideTerminal: true });
      return true;
    },
  });

  const made = addTab({
    title: `⌗ ${name}`,
    key,
    kind: "terminal",
    workspace: ws,
    // close() resolves when cleanup (incl. a late-materializing pty detach)
    // actually ran — closeTab reserves the key on this promise.
    onClose: () => { offTheme(); offTypography(); return tab.close(); },
    onShow: () => { requestAnimationFrame(() => { try { fit.fit(); } catch {} }); },
    // user-initiated activation → keyboard lands in the xterm textarea
    focusContent: () => { try { term.focus(); } catch {} },
    focusOnActivate: true, // addTab's own dedup here is a user jump too
  });
  if (!made) { offTheme(); offTypography(); term.dispose(); return; } // lost a race to an identical tab
  made.paneEl.append(wrap);
  term.open(wrap);
  fit.fit();

  await tab.start();
}

// ── nav rail ──────────────────────────────────────────────────────────────
// First-class stage destinations come from shell-nav.mjs (NAV) so tests can
// prove every entry resolves to a real mount-exporting view. The permanent
// instance tree in the sidebar is the instances surface itself — selecting
// an instance opens its terminal; there is no separate Instances stage.
const navEl = document.getElementById("nav");
for (const v of NAV) {
  const b = document.createElement("button");
  b.className = "nav-item";
  b.title = v.title;
  b.dataset.view = v.name;
  b.dataset.action = `stage.${v.name}`;
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
  b.dataset.action = "app.themeToggle";
  b.innerHTML = `<span class="icon">◐</span><span class="label">Theme</span>`;
  b.addEventListener("click", () => toggleTheme());
  (foot || navEl).append(b);
}

// ── command palette (⌘K): jump to an instance or run a command ─────────
const isMac = navigator.platform.includes("Mac");
const chordDetail = (id) => () => {
  const b = getBinding(id);
  return b ? formatChord(b, isMac) : "";
};
const palette = createPalette({
  loadInstances: async () => {
    const ws = currentWorkspace();
    const p = await api(`/api/panel${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
    return p.instances || [];
  },
  openTerminal: (name) => openTerminalTab(name),
  commands: [
    // View commands derive from the nav manifest so a new rail destination
    // can never be palette-invisible (review 8441961 nit).
    ...NAV.map((v) => ({ label: `View: ${v.label}`, detail: chordDetail(`stage.${v.name}`), run: () => showStage(v.name) })),
    { label: "Souls: quick open…", detail: chordDetail("app.quickOpenSouls"), run: () => quickOpen.open() },
    { label: "Theme: toggle light/dark", detail: chordDetail("app.themeToggle"), run: () => toggleTheme() },
    { label: "Shortcuts: edit keyboard shortcuts…", detail: chordDetail("app.shortcuts"), run: () => openShortcutsEditor() },
    { label: "Workspace: switch…", detail: chordDetail("app.workspaces"), run: () => workspaceLabel.openMenu() },
    { label: "Instances: focus the sidebar roster", detail: chordDetail("sidebar.focusFilter"), run: () => focusRoster() },
    { label: "Sidebar: toggle (hide/show)", detail: chordDetail("sidebar.toggle"), run: () => toggleSidebar() },
    { label: "Split: terminal right (side by side)", detail: chordDetail("split.vertical"), run: () => splitPane("row") },
    { label: "Split: terminal down (stacked)", detail: chordDetail("split.horizontal"), run: () => splitPane("col") },
    { label: "Split: close (back to single pane)", detail: chordDetail("split.close"), run: () => closeSplit() },
    { label: "Terminal: focus the active terminal input", detail: chordDetail("terminal.focusActive"), run: () => focusActiveTerminal() },
    { label: "Terminal: increase font size", detail: chordDetail("terminal.fontBigger"), run: () => setTerminalFontSize(terminalTypography().fontSize + 1) },
    { label: "Terminal: decrease font size", detail: chordDetail("terminal.fontSmaller"), run: () => setTerminalFontSize(terminalTypography().fontSize - 1) },
    { label: "Terminal: set font family…", run: () => {
      const current = terminalTypography().fontFamily;
      const next = window.prompt("Terminal font family (CSS font-family value)", current);
      if (next !== null) setTerminalFontFamily(next);
    } },
    { label: "Terminal: reset typography", detail: chordDetail("terminal.fontReset"), run: () => { setTerminalFontFamily(""); setTerminalFontSize(13); } },
  ],
});

// ── Quick Open for souls (Mod+P): find a soul, land in its spawn form ──
// Selection hands off to the Spawn view's OWN form flow (preselectSoul —
// consumed by the view's next roster paint), so CLI degradation and the
// attached-only rule render exactly as the Spawn view always renders them.
// Terminal policy (documented): app.quickOpenSouls is NOT terminal-
// allowlisted — ⌘P fires inside xterm on macOS by the ⌘-chord policy, but
// Ctrl+P inside xterm on Linux/Windows belongs to the shell's history.
const quickOpen = createQuickOpen({
  loadSouls: async () => {
    const ws = currentWorkspace();
    return api(`/api/agents${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`);
  },
  onPick: async (soul) => {
    const { preselectSoul } = await import("./views/spawn.mjs");
    preselectSoul(soul);
    showStage("spawn");
  },
});

// ── shortcuts editor (rail-footer button + palette + Mod+,) ────────────
const shortcutsEditor = createKeybindingsEditor({ doc: document, isMac });
function openShortcutsEditor() { shortcutsEditor.open(); }

function focusRoster() {
  contextRosterEl?.querySelector(".ctx-filter")?.focus();
}

// ── hideable sidebar: full-width terminals on demand ───────────────────
// Class-driven (display:flex on #sidebar beats the hidden attribute) and
// persisted like the other shell prefs. Terminal refits ride each tab's
// ResizeObserver — the panes change width when the sidebar goes away.
const SIDEBAR_HIDDEN_KEY = "oas-desktop-sidebar-hidden";
function sidebarHidden() {
  return document.getElementById("app").classList.contains("sidebar-hidden");
}
function setSidebarHidden(on) {
  document.getElementById("app").classList.toggle("sidebar-hidden", on);
  try {
    if (on) localStorage.setItem(SIDEBAR_HIDDEN_KEY, "1");
    else localStorage.removeItem(SIDEBAR_HIDDEN_KEY);
  } catch { /* storage-less */ }
}
function toggleSidebar() { setSidebarHidden(!sidebarHidden()); }
try { if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1") setSidebarHidden(true); } catch { /* storage-less */ }

/** Focus the ACTIVE terminal tab's xterm input from anywhere in the shell
 * (explicit action — rebindable, editor-visible). No default chord: every
 * safe candidate is taken or terminal-hostile (any Ctrl chord belongs to
 * the pty on Linux/Windows; plain keys are guarded off editables) — users
 * who want one bind it in the shortcuts editor. */
function focusActiveTerminal() {
  const t = activeTab != null ? tabs.get(activeTab) : null;
  if (t?.kind === "terminal") t.focusContent?.();
}

function visibleTabEntries() {
  return [...tabs].filter(([, t]) => !t.tabEl.hidden);
}

function cycleTab(delta) {
  const vis = visibleTabEntries();
  if (!vis.length) return;
  const at = Math.max(0, vis.findIndex(([tid]) => tid === activeTab));
  const [nextId] = vis[(at + delta + vis.length) % vis.length];
  activateTab(nextId);
}

// ── action registry: every mouse affordance, one keyboard action ────────
// Default chords live in the engine's DEFAULT_KEYMAP (keybindings.mjs);
// user overrides persist in localStorage via the shortcuts editor.
registerAction({ id: "app.palette", label: "Open the command palette", context: "global", run: () => palette.toggle() });
registerAction({ id: "app.quickOpenSouls", label: "Quick open a soul to spawn", context: "global", run: () => quickOpen.toggle() });
registerAction({ id: "app.shortcuts", label: "Edit keyboard shortcuts", context: "global", run: () => openShortcutsEditor() });
// stage-switch actions derive from the nav manifest (same rule as the
// palette): a new rail destination can never be shortcut-invisible.
NAV.forEach((v) => registerAction({
  id: `stage.${v.name}`, label: `View: ${v.label}`, context: "global",
  run: () => showStage(v.name),
}));
registerAction({ id: "app.themeToggle", label: "Toggle light/dark theme", context: "global", run: () => toggleTheme() });
registerAction({ id: "app.workspaces", label: "Open the workspace switcher", context: "global", run: () => workspaceLabel.openMenu() });
registerAction({ id: "sidebar.focusFilter", label: "Focus the instance roster filter", context: "global", run: () => focusRoster() });
registerAction({ id: "sidebar.toggle", label: "Toggle the sidebar", context: "global", run: () => toggleSidebar() });
// splits live on the tab layer (they arrange terminal tabs); the actions
// are terminal-allowlisted so the chords work inside xterm too.
registerAction({ id: "split.vertical", label: "Split terminal right (side by side)", context: "tabs", run: () => splitPane("row") });
registerAction({ id: "split.horizontal", label: "Split terminal down (stacked)", context: "tabs", run: () => splitPane("col") });
registerAction({ id: "split.close", label: "Close the split (single pane)", context: "tabs", run: () => closeSplit() });
// No defaultChord (documented): safe candidates are exhausted — rebindable in the editor.
registerAction({ id: "terminal.focusActive", label: "Focus the active terminal input", context: "global", run: () => focusActiveTerminal() });
registerAction({ id: "terminal.fontBigger", label: "Terminal: increase font size", context: "global", run: () => setTerminalFontSize(terminalTypography().fontSize + 1) });
registerAction({ id: "terminal.fontSmaller", label: "Terminal: decrease font size", context: "global", run: () => setTerminalFontSize(terminalTypography().fontSize - 1) });
registerAction({ id: "terminal.fontReset", label: "Terminal: reset typography", context: "global", run: () => { setTerminalFontFamily(""); setTerminalFontSize(13); } });
// tabs: cycle + close work whether or not a tab trigger has focus (the
// tab-a11y roving arrows stay as focus keys on the strip itself).
registerAction({ id: "tabs.next", label: "Next tab", context: "tabs", run: () => cycleTab(1) });
registerAction({ id: "tabs.prev", label: "Previous tab", context: "tabs", run: () => cycleTab(-1) });
registerAction({ id: "tabs.close", label: "Close the active tab", context: "tabs", run: () => { if (activeTab != null) closeTab(activeTab, true); } });

// THE one window keydown listener. The engine owns the terminal policy
// (⌘ chords on mac; the action-id allowlist on Linux/Windows — Ctrl+K now
// opens the palette inside xterm there, superseding the legacy
// isPaletteShortcut pass-through). View-local handlers (hierarchy canvas,
// roster rows, palette input) preventDefault the keys they consume; the
// engine must not double-dispatch them.
// The engine skips already-consumed (defaultPrevented) events itself.
window.addEventListener("keydown", (e) => handleKeydown(e));

// rail-footer: Shortcuts button next to Theme
{
  const foot = document.getElementById("nav-foot");
  const b = document.createElement("button");
  b.className = "nav-item";
  b.title = "Edit keyboard shortcuts";
  b.dataset.action = "app.shortcuts";
  b.innerHTML = `<span class="icon">⌨</span><span class="label">Shortcuts</span>`;
  b.addEventListener("click", () => openShortcutsEditor());
  (foot || navEl).append(b);
}

// Chord-suffixed tooltips, live against the keymap: any control that
// declares data-action gets “ … (chord)” appended to its base title.
const baseTitles = new WeakMap();
function applyChordTitles() {
  for (const el of document.querySelectorAll("[data-action]")) {
    if (!baseTitles.has(el)) baseTitles.set(el, el.title || "");
    const chord = getBinding(el.dataset.action);
    const base = baseTitles.get(el);
    el.title = chord ? `${base} (${formatChord(chord, isMac)})` : base;
  }
}
onKeymapChange(() => applyChordTitles());
applyChordTitles();

// Persistent recursive instance tree: always available below the three nav
// surfaces, with no second/contextual sidebar and no width jump.
initContextRoster();
onWorkspaceChange(() => {
  contextRosterGen++;
  brainIntents.invalidate();
  workspaceLabel.reset();
  contextInstances = [];
  contextWorkspace = currentWorkspace();
  split = null; // splits are per-workspace arrangements of its terminal tabs
  updateContextTabs();
  if (sidebarMode === "instances") showTerminalContext();
  else refreshContextRoster();
});
setInterval(() => refreshContextRoster(), 4000);

// Contract re-probe triggers: launch (initial refresh) and app focus. The
// cli-status module owns the shared state; the Spawn view (and any future
// mutation surface) subscribes for consistent enable/disable.
import("./views/cli-status.mjs").then(({ refreshCli, reprobeCli }) => {
  refreshCli(ctx);
  desk.onAppFocus?.(() => reprobeCli(ctx));
});

// Home surface: the agent hierarchy — running instances and how they relate.
showStage("hierarchy");
