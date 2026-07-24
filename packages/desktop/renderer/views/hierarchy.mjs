/* oas desktop — Agents hierarchy view (the home surface).
   An interactive tidy tree of who spawned whom, per workspace: spawn
   parentage comes from the roster's parentInstance (a forest — so a layered
   tidy tree, deliberately NOT force-directed: deterministic, no jitter).
   Node cards show the app-wide status vocabulary (running = filled green
   dot; idle = hollow dot + dimmed card — never color alone, WCAG). Click
   selects and shows the action popover; double-click / Enter opens the
   terminal; hovering highlights the lineage.
   Canvas: pan by drag, zoom by pinch/⌘-wheel or the −/+/fit controls; the
   graph auto-fits the visible screen on first paint and after workspace
   switches; each agent box can be grabbed and moved freely (drag past the
   click threshold — spawn edges follow live, and offsets persist across the
   4s refresh).
   Keyboard: arrows walk the tree, Enter opens, f fits, Escape clears.
   Contract: mount(el, ctx) / unmount(); data from GET /api/panel only. */
import {
  escapeHtml, apiJson, ensureTheme,
  currentWorkspace, setWorkspace, adoptWorkspace, onWorkspaceChange,
  renderWorkspaceSelect, wsQuery, workspaceGeneration,
} from "./common.mjs";

const CSS = `
.hier { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); color: var(--fg);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.hier * { box-sizing: border-box; }
.hier-bar { display: flex; align-items: center; gap: 10px; height: var(--bar-h); flex: none; padding: 0 14px;
            border-bottom: 1px solid var(--border); background: var(--surface); }
.hier-sum { color: var(--muted); font-size: 12.5px; }
.hier-sum b { color: var(--fg); font-weight: 600; }
.hier-canvas { flex: 1; position: relative; overflow: hidden; min-height: 0; cursor: grab; outline: none; }
.hier-canvas.panning { cursor: grabbing; }
.hier-stage { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
.hier-group { position: absolute; }
.hier-zoom { position: absolute; right: 14px; bottom: 14px; z-index: 5; display: flex; gap: 4px;
             background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 3px; box-shadow: var(--shadow); }
.hier-zoom button { background: none; border: none; color: var(--muted); font: 14px/1 inherit; width: 26px; height: 24px;
                    border-radius: 5px; cursor: pointer; }
.hier-zoom button:hover { background: var(--surface-2); color: var(--fg); }
.hier-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.hier-edges path { stroke: var(--graph-edge); stroke-width: 1.5; fill: none; }
.hier-edges path.lit { stroke: var(--accent); stroke-width: 2; }
.hier-ws { position: absolute; color: var(--faint); font-size: 11px; font-weight: 650;
           text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; }
.hnode { position: absolute; width: 208px; background: var(--surface); border: 1px solid var(--border);
         border-radius: 10px; padding: 8px 11px; box-shadow: var(--shadow); cursor: pointer; user-select: none; }
.hnode.dragging { cursor: grabbing; }
.hnode:hover { background: var(--surface-2); }
.hnode.idle { border-style: dashed; background: var(--surface-2); }
.hnode.sel { border-color: var(--accent); background: var(--sel); }
.hnode.lit { border-color: var(--accent); }
.hnode .hname { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 7px; min-width: 0; }
.hnode .hname .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hnode .hmeta { color: var(--muted); font-size: 11.5px; margin-top: 3px; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; }
.hdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.hdot.on { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
.hdot.off { background: transparent; border: 1.5px solid var(--faint); }
.hier-pop { position: absolute; z-index: 4; width: 232px; background: var(--surface); border: 1px solid var(--border);
            border-radius: 10px; box-shadow: var(--shadow); padding: 10px 12px; }
.hier-pop .ptask { color: var(--muted); font-size: 12px; margin: 2px 0 8px; max-height: 54px; overflow: hidden; }
.hier-pop .pchips { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 9px; }
.hier-pop .pacts { display: flex; gap: 6px; }
.hier-pop .pacts button { flex: 1; }
.hier-empty-wrap { flex: 1; display: flex; align-items: center; justify-content: center; }
`;

const NODE_W = 208, NODE_H = 58, GAP_X = 26, GAP_Y = 46, PAD = 40;

/* Tidy-tree layout for a forest: post-order, children centered under the
   parent; leaves packed left-to-right. Returns nodes with x/y set. */
export function layoutForest(instances) {
  const byName = new Map(instances.map((i) => [i.instance, { inst: i, children: [] }]));
  const roots = [];
  const parentOf = new Map();
  for (const n of byName.values()) {
    const p = n.inst.parentInstance && byName.get(n.inst.parentInstance);
    if (p && p !== n) { p.children.push(n); parentOf.set(n, p); }
    else roots.push(n);
  }
  const rank = (a, b) => (a.inst.running === b.inst.running
    ? a.inst.instance.localeCompare(b.inst.instance) : a.inst.running ? -1 : 1);

  // A malformed parentInstance cycle has no natural root and used to vanish
  // entirely. Mark normal root-reachable nodes, then promote one deterministic
  // node from every still-unreachable component and sever only its incoming
  // edge. Because every node has at most one parent, that single cut breaks the
  // component's cycle while retaining all nodes and all other valid edges.
  const reachable = new Set();
  const mark = (n) => {
    if (reachable.has(n)) return;
    reachable.add(n);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  for (const start of [...byName.values()].sort(rank)) {
    if (reachable.has(start)) continue;

    // Follow parent links from this node until the path repeats. `start` may
    // be a valid descendant that merely sorts ahead of its malformed cycle;
    // only nodes in the repeated suffix are eligible for promotion.
    const path = [], pathIndex = new Map();
    let cursorNode = start;
    while (cursorNode && !reachable.has(cursorNode) && !pathIndex.has(cursorNode)) {
      pathIndex.set(cursorNode, path.length);
      path.push(cursorNode);
      cursorNode = parentOf.get(cursorNode);
    }
    const cycle = cursorNode && pathIndex.has(cursorNode)
      ? path.slice(pathIndex.get(cursorNode))
      : [];
    const promoted = cycle.length ? [...cycle].sort(rank)[0] : start;
    const p = parentOf.get(promoted);
    if (p) p.children = p.children.filter((child) => child !== promoted);
    parentOf.delete(promoted);
    roots.push(promoted);
    mark(promoted);
  }

  roots.sort(rank);
  let cursor = 0; // next free leaf x slot
  const place = (n, depth) => {
    n.children.sort(rank);
    n.y = depth * (NODE_H + GAP_Y);
    if (!n.children.length) {
      n.x = cursor;
      cursor += NODE_W + GAP_X;
      return;
    }
    for (const c of n.children) place(c, depth + 1);
    const first = n.children[0], last = n.children[n.children.length - 1];
    n.x = (first.x + last.x) / 2;
    // parent wider than its subtree span never overlaps a neighbor
    if (n.x + NODE_W + GAP_X > cursor) cursor = n.x + NODE_W + GAP_X;
  };
  for (const r of roots) place(r, 0);
  const all = [];
  const collect = (n) => { all.push(n); n.children.forEach(collect); };
  roots.forEach(collect);
  return { nodes: all, width: Math.max(cursor - GAP_X, NODE_W), height: (Math.max(...all.map((n) => n.y), 0)) + NODE_H };
}

let state = null;

const DRAG_THRESHOLD = 5; // px before a node-drag moves its tree (else it's a click)

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  const s = state = {
    el, ctx, panel: { instances: [] }, sel: null,
    tx: PAD, ty: PAD, z: 1, fitted: false,
    nodeOffsets: new Map(),        // instance -> {x,y} user-dragged box offsets
    timers: [], unsubWs: null, alive: true,
    nodeEls: new Map(), lineage: new Set(),
  };
  el.innerHTML = `
    <div class="hier oas-view" style="display:flex">
      <style>${CSS}</style>
      <div class="hier-bar">
        <select class="field wssel" style="display:none"></select>
        <span class="hier-sum"><span class="spinner"></span></span>
        <span style="flex:1"></span>
        <button class="act spawnbtn" title="Spawn a new agent instance">✚ Spawn</button>
      </div>
      <div class="hier-canvas" tabindex="0" role="tree" aria-label="Agent hierarchy">
        <div class="hier-zoom">
          <button class="zout" title="Zoom out (⌘−)" aria-label="Zoom out">−</button>
          <button class="zfit" title="Fit to screen (f)" aria-label="Fit to screen">◲</button>
          <button class="zin" title="Zoom in (⌘+)" aria-label="Zoom in">+</button>
        </div>
      </div>
    </div>`;
  s.q = (cls) => el.querySelector("." + cls);
  s.canvas = s.q("hier-canvas");
  s.q("wssel").addEventListener("change", (e) => setWorkspace(e.target.value));
  s.q("spawnbtn").addEventListener("click", () => ctx.openView ? ctx.openView("spawn") : null);
  if (!ctx.openView) s.q("spawnbtn").style.display = "none";
  s.q("zin").addEventListener("click", () => zoomBy(s, 1.2));
  s.q("zout").addEventListener("click", () => zoomBy(s, 1 / 1.2));
  s.q("zfit").addEventListener("click", () => fit(s));

  // canvas pan by drag (ignore drags that start on a node/popover/controls)
  let pan = null;
  s.canvas.addEventListener("mousedown", (e) => {
    if (e.target.closest(".hnode") || e.target.closest(".hier-pop") || e.target.closest(".hier-zoom")) return;
    pan = { x: e.clientX - s.tx, y: e.clientY - s.ty };
    s.canvas.classList.add("panning");
    closePop(s);
  });
  window.addEventListener("mousemove", s.onMove = (e) => {
    if (s.drag) { onNodeDragMove(s, e); return; }
    if (!pan) return;
    s.tx = e.clientX - pan.x; s.ty = e.clientY - pan.y;
    applyTransform(s);
  });
  window.addEventListener("mouseup", s.onUp = (e) => {
    if (s.drag) { onNodeDragEnd(s, e); return; }
    pan = null; s.canvas.classList.remove("panning");
  });

  // zoom: pinch / ⌘-wheel zooms about the cursor; plain wheel pans
  s.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomBy(s, factor, e.clientX, e.clientY);
    } else {
      s.tx -= e.deltaX; s.ty -= e.deltaY;
      applyTransform(s);
    }
  }, { passive: false });

  // keyboard: walk the tree, Enter opens terminal, f fits, Escape clears
  s.canvas.addEventListener("keydown", (e) => onKey(s, e));

  s.unsubWs = onWorkspaceChange(() => { s.sel = null; s.fitted = false; s.nodeOffsets.clear(); refresh(s); });
  refresh(s);
  s.timers.push(setInterval(() => refresh(s), 4000));

  return () => teardown(s);
}

export function unmount() { if (state) teardown(state); }

function teardown(s) {
  if (!s.alive) return;
  s.alive = false;
  s.timers.forEach(clearInterval);
  if (s.unsubWs) s.unsubWs();
  window.removeEventListener("mousemove", s.onMove);
  window.removeEventListener("mouseup", s.onUp);
  s.el.innerHTML = "";
  if (state === s) state = null;
}

/* Exported for the deferred cross-workspace regression. */
export async function refresh(s) {
  const myGen = workspaceGeneration();       // capture at dispatch (house standard)
  let panel;
  try { panel = await apiJson(s.ctx, `/api/panel${wsQuery()}`); }
  catch { return; } // keep the last good graph on transient errors
  // BOTH success and failure paths are gated: a deferred roster from
  // workspace A must never paint after switching to B, or after unmount.
  if (!s.alive || myGen !== workspaceGeneration()) return;
  s.panel = panel;
  if (panel.workspace && panel.workspace.id !== currentWorkspace()) adoptWorkspace(panel.workspace.id);
  renderWorkspaceSelect(s.q("wssel"), panel.workspaces, panel.workspace?.id || "");
  render(s);
}

function render(s) {
  const canvas = s.canvas;
  const prevPop = s.popFor;
  const zoomCtl = canvas.querySelector(".hier-zoom");
  canvas.innerHTML = "";
  if (zoomCtl) canvas.append(zoomCtl);
  s.nodeEls.clear();
  const list = s.panel.instances || [];
  const running = list.filter((i) => i.running).length;
  s.q("hier-sum").innerHTML =
    `<b>${running}</b> running · <b>${list.length - running}</b> idle`;
  if (!list.length) {
    const w = document.createElement("div");
    w.className = "hier-empty-wrap";
    w.style.height = "100%";
    w.innerHTML = `<div class="empty"><span class="big">◎</span>` +
      `No instances yet.<br>Spawn one from the Spawn view or with <code>oas spawn &lt;agent&gt;</code>.</div>`;
    canvas.append(w);
    return;
  }

  // Build parentage from the FULL roster before any visual decoration.
  // parentInstance may cross agent/workspace roots in a team-scoped panel;
  // pre-grouping would turn a valid child into an orphan and drop its edge.
  // Node metadata still identifies its repo/root, and free dragging provides
  // visual partitioning without corrupting topology.
  const { nodes, width, height } = layoutForest(list);
  const stage = document.createElement("div");
  stage.className = "hier-stage";
  const group = document.createElement("div");
  group.className = "hier-group";
  group.dataset.ws = "all";
  group.style.left = "0";
  group.style.top = "0";

  const BLEED = 2000; // edge svg overdraw so dragged boxes keep their edges
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("hier-edges");
  svg.setAttribute("width", width + BLEED * 2);
  svg.setAttribute("height", height + NODE_H + BLEED * 2);
  svg.setAttribute("viewBox", `${-BLEED} ${-BLEED} ${width + BLEED * 2} ${height + NODE_H + BLEED * 2}`);
  svg.style.left = `${-BLEED}px`; svg.style.top = `${-BLEED}px`;
  group.append(svg);

  s.edgesByNode = new Map(); // instance -> [path els touching it]
  s.bounds = { w: width, h: height };
  // final position = tidy layout + any user drag offset
  for (const n of nodes) {
    const off = s.nodeOffsets.get(n.inst.instance) || { x: 0, y: 0 };
    n.fx = n.x + off.x; n.fy = n.y + off.y;
    group.append(nodeEl(s, n, n.inst.workspace || "?"));
  }
  for (const n of nodes) {
    for (const c of n.children) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.dataset.child = c.inst.instance;
      p.dataset.parent = n.inst.instance;
      drawEdge(p, n, c);
      svg.append(p);
      for (const nm of [n.inst.instance, c.inst.instance]) {
        if (!s.edgesByNode.has(nm)) s.edgesByNode.set(nm, []);
        s.edgesByNode.get(nm).push(p);
      }
    }
  }
  stage.append(group);
  canvas.append(stage);
  // first paint (or workspace switch): fit the forest to the visible screen
  if (!s.fitted) { s.fitted = true; fit(s); } else applyTransform(s);
  if (s.sel && !list.some((i) => i.instance === s.sel)) s.sel = null;
  paintSelection(s);
  // keep the popover across the 4s refresh if its instance still exists
  if (prevPop && list.some((i) => i.instance === prevPop)) openPop(s, prevPop);
}

function nodeEl(s, n, wsName) {
  const i = n.inst;
  const d = document.createElement("div");
  d.className = "hnode" + (i.running ? "" : " idle");
  d.style.left = `${n.fx}px`; d.style.top = `${n.fy}px`;
  d.setAttribute("role", "treeitem");
  d.setAttribute("aria-label", `${i.instance}, ${i.running ? "running" : "idle"}`);
  d.dataset.name = i.instance;
  d.innerHTML = `
    <div class="hname"><span class="hdot ${i.running ? "on" : "off"}" aria-hidden="true"></span><span class="nm">${escapeHtml(i.instance)}</span></div>
    <div class="hmeta">${escapeHtml(i.agent || "")}${i.repoName ? " · " + escapeHtml(i.repoName) : ""}</div>`;
  d.title = i.task ? String(i.task).slice(0, 200) : i.instance;
  // drag-to-move: grabbing a box past the threshold moves THAT BOX (edges
  // follow live); under the threshold it stays a click/dblclick.
  d.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    const off = s.nodeOffsets.get(i.instance) || { x: 0, y: 0 };
    s.drag = { name: i.instance, node: d, n, startX: e.clientX, startY: e.clientY, off: { ...off }, moved: false };
  });
  d.addEventListener("click", (e) => {
    e.stopPropagation();
    if (s.dragConsumedClick) { s.dragConsumedClick = false; return; }
    select(s, i.instance);
  });
  d.addEventListener("dblclick", (e) => { e.stopPropagation(); s.ctx.openTerminal(i.instance); });
  d.addEventListener("mouseenter", () => litLineage(s, i.instance, true));
  d.addEventListener("mouseleave", () => litLineage(s, i.instance, false));
  s.nodeEls.set(i.instance, { el: d, node: n, ws: wsName });
  return d;
}

/* Edge between a parent and child node, from their FINAL (fx/fy) positions. */
function drawEdge(p, parent, child) {
  const x1 = parent.fx + NODE_W / 2, y1 = parent.fy + NODE_H;
  const x2 = child.fx + NODE_W / 2, y2 = child.fy;
  const my = (y1 + y2) / 2;
  p.setAttribute("d", `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
}

function onNodeDragMove(s, e) {
  const dr = s.drag;
  const dx = (e.clientX - dr.startX) / s.z, dy = (e.clientY - dr.startY) / s.z;
  if (!dr.moved && Math.hypot(e.clientX - dr.startX, e.clientY - dr.startY) < DRAG_THRESHOLD) return;
  if (!dr.moved) { dr.moved = true; dr.node.classList.add("dragging"); closePop(s); }
  const nx = dr.off.x + dx, ny = dr.off.y + dy;
  s.nodeOffsets.set(dr.name, { x: nx, y: ny });
  dr.n.fx = dr.n.x + nx; dr.n.fy = dr.n.y + ny;
  dr.node.style.left = `${dr.n.fx}px`;
  dr.node.style.top = `${dr.n.fy}px`;
  // redraw only the edges touching this box
  for (const p of s.edgesByNode?.get(dr.name) || []) {
    const parent = s.nodeEls.get(p.dataset.parent)?.node;
    const child = s.nodeEls.get(p.dataset.child)?.node;
    if (parent && child) drawEdge(p, parent, child);
  }
}

function onNodeDragEnd(s) {
  const dr = s.drag;
  s.drag = null;
  dr.node.classList.remove("dragging");
  if (dr.moved) s.dragConsumedClick = true; // the click after a drag is not a select
}

function applyTransform(s) {
  const stage = s.canvas.querySelector(".hier-stage");
  if (stage) stage.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(${s.z})`;
}

const Z_MIN = 0.25, Z_MAX = 2;
function zoomBy(s, factor, cx, cy) {
  const rect = s.canvas.getBoundingClientRect();
  const px = cx != null ? cx - rect.left : rect.width / 2;   // zoom about cursor (or center)
  const py = cy != null ? cy - rect.top : rect.height / 2;
  const nz = Math.min(Z_MAX, Math.max(Z_MIN, s.z * factor));
  const k = nz / s.z;
  s.tx = px - (px - s.tx) * k;
  s.ty = py - (py - s.ty) * k;
  s.z = nz;
  applyTransform(s);
}

/* Fit the whole forest (incl. dragged offsets) inside the visible canvas. */
function fit(s) {
  if (typeof s.canvas.getBoundingClientRect !== "function") return; // non-DOM host (tests)
  const rect = s.canvas.getBoundingClientRect();
  if (!rect.width || !s.bounds || !s.bounds.w) { s.tx = PAD; s.ty = PAD; s.z = 1; applyTransform(s); return; }
  // actual extent: every node's FINAL (layout + drag) position
  let minX = 0, minY = 0, maxX = s.bounds.w, maxY = s.bounds.h + NODE_H;
  for (const { el, node } of s.nodeEls.values()) {
    const gx = Number(el.parentElement?.style.left?.replace("px", "") || 0);
    const fx = gx + (node.fx ?? node.x), fy = node.fy ?? node.y;
    minX = Math.min(minX, fx); minY = Math.min(minY, fy);
    maxX = Math.max(maxX, fx + NODE_W); maxY = Math.max(maxY, fy + NODE_H);
  }
  const w = maxX - minX, h = maxY - minY;
  const z = Math.min(Z_MAX, Math.max(Z_MIN, Math.min((rect.width - PAD * 2) / w, (rect.height - PAD * 2) / h, 1)));
  s.z = z;
  s.tx = (rect.width - w * z) / 2 - minX * z;
  s.ty = Math.max(PAD, (rect.height - h * z) / 2 - minY * z);
  applyTransform(s);
}

/* lineage highlight: ancestors + descendants of the hovered node */
function litLineage(s, name, on) {
  const byName = new Map((s.panel.instances || []).map((i) => [i.instance, i]));
  const kin = new Set([name]);
  let cur = byName.get(name);
  while (cur && cur.parentInstance && byName.has(cur.parentInstance) && !kin.has(cur.parentInstance)) {
    kin.add(cur.parentInstance); cur = byName.get(cur.parentInstance);
  }
  const grow = (nm) => {
    for (const i of byName.values()) if (i.parentInstance === nm && !kin.has(i.instance)) { kin.add(i.instance); grow(i.instance); }
  };
  grow(name);
  for (const [nm, { el }] of s.nodeEls) el.classList.toggle("lit", on && kin.has(nm) && nm !== s.sel);
  for (const paths of (s.edgesByNode || new Map()).values()) {
    for (const p of paths) {
      const lit = on && kin.has(p.dataset.child) && kin.has(p.dataset.parent);
      p.classList.toggle("lit", lit);
    }
  }
}

function select(s, name) {
  s.sel = name;
  paintSelection(s);
  openPop(s, name);
}

function paintSelection(s) {
  for (const [nm, { el }] of s.nodeEls) el.classList.toggle("sel", nm === s.sel);
}

function closePop(s) {
  s.canvas.querySelector(".hier-pop")?.remove();
  s.popFor = null;
}

function openPop(s, name) {
  closePop(s);
  const entry = s.nodeEls.get(name);
  const i = (s.panel.instances || []).find((x) => x.instance === name);
  if (!entry || !i) return;
  s.popFor = name;
  const pop = document.createElement("div");
  pop.className = "hier-pop";
  pop.style.left = `${entry.node.fx ?? entry.node.x}px`;
  pop.style.top = `${(entry.node.fy ?? entry.node.y) + NODE_H + 8}px`;
  pop.innerHTML = `
    ${i.task ? `<div class="ptask">${escapeHtml(String(i.task).slice(0, 160))}</div>` : ""}
    <div class="pchips">
      <span class="chip rt">${escapeHtml(i.runtime || "")}</span>
      ${i.branch ? `<span class="chip">${escapeHtml(i.branch)}</span>` : ""}
      ${i.git && i.git.dirty ? `<span class="chip dirty">±${Number(i.git.dirty)}</span>` : ""}
    </div>
    <div class="pacts">
      <button class="act pterm"${i.running ? "" : " disabled"}>Terminal</button>
      <button class="act pbrain">Brain</button>
    </div>`;
  pop.querySelector(".pterm").addEventListener("click", () => s.ctx.openTerminal(name));
  pop.querySelector(".pbrain").addEventListener("click", () => s.ctx.openBrain?.(i.agent));
  if (!s.ctx.openBrain) pop.querySelector(".pbrain").style.display = "none";
  // append inside the node's group so the popover sits by its (dragged) box
  (entry.el.parentElement || s.canvas.querySelector(".hier-stage"))?.append(pop);
}

/* keyboard tree-walk over the laid-out nodes */
function onKey(s, e) {
  const list = s.panel.instances || [];
  if (!list.length) return;
  if (e.key === "Escape") { s.sel = null; paintSelection(s); closePop(s); return; }
  if (e.key === "f") { e.preventDefault(); fit(s); return; }
  if (e.key === "Enter" && s.sel) { e.preventDefault(); s.ctx.openTerminal(s.sel); return; }
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  if (!s.sel) { select(s, list[0].instance); return; }
  const cur = s.nodeEls.get(s.sel);
  if (!cur) return;
  const byName = new Map(list.map((i) => [i.instance, i]));
  if (e.key === "ArrowUp") {
    const p = byName.get(s.sel)?.parentInstance;
    if (p && s.nodeEls.has(p)) select(s, p);
  } else if (e.key === "ArrowDown") {
    const kid = cur.node.children[0];
    if (kid) select(s, kid.inst.instance);
  } else {
    // siblings: same row (y) within the SAME workspace group, ordered by x
    const sibs = [...s.nodeEls.values()].filter((x) => x.node.y === cur.node.y && x.ws === cur.ws).sort((a, b) => a.node.x - b.node.x);
    const at = sibs.findIndex((x) => x.node.inst.instance === s.sel);
    const next = sibs[at + (e.key === "ArrowRight" ? 1 : -1)];
    if (next) select(s, next.node.inst.instance);
  }
}
