// Editor-group DOM projection — the testable layer between the pure split
// model (split-layout.mjs) and the shell.
//
// While a split is visible, #tabhost holds one `.group-cell` per group
// (flex row for orientation "row" = side-by-side, column for "col" =
// stacked). Each cell owns its group's chrome and content:
//
//   .group-cell[data-group=<id>]
//     .group-tabbar (role=tablist)  ← the group's REAL tab elements, in
//                                     group order (one chrome per tab, so
//                                     tab-a11y roving/aria/close semantics
//                                     ride with the node), plus #tab-actions
//                                     appended to the FOCUSED group's strip
//     …member tab panes…            ← ALL of the group's panes parked here;
//                                     the shell shows only the group-active
//                                     one (FitAddon refit rides its pane's
//                                     ResizeObserver when the cell resizes)
//     (or `emptyEl`)                ← the placeholder while the group is
//                                     empty — the model allows at most one
//                                     empty group, so one element suffices
//
// The top-level #tabstrip row is HIDDEN while the split is visible: every
// visible tab lives in a group strip, so keeping the old row would render
// exactly the empty phantom chrome bar the human reported against PR #44.
// The flat (non-split) state restores everything: tabs back to #tabbar in
// tab-creation order, #tab-actions back to its #tabbar-row slot, panes back
// to #tabhost, strip visible — byte-identical to the pre-split shell
// (regression-pinned).
//
// The projection is idempotent and moves a node only when it is out of
// place: re-inserting an already-placed element would tear it out of the
// DOM mid-interaction (projection runs from activateTab, which pane
// pointerdown triggers). Moving the focused element between containers can
// drop focus to <body>; restore it by node afterwards.

// a Comment marker holds #tab-actions' flat slot while the controls ride a
// group strip, so the restore is byte-identical (whitespace preserved).
const MARKER = Symbol("flat-slot-marker");

function ensureCell(host, before, group) {
  let cell = host.querySelector(`:scope > .group-cell[data-group="${group.id}"]`);
  if (!cell) {
    const doc = host.ownerDocument;
    cell = doc.createElement("div");
    cell.className = "group-cell";
    cell.dataset.group = String(group.id);
    const bar = doc.createElement("div");
    bar.className = "group-tabbar";
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Editor group tabs");
    cell.append(bar);
  }
  if (before ? before.nextSibling !== cell : host.firstChild !== cell) {
    if (before) before.after(cell); else host.prepend(cell);
  }
  return cell;
}

function placeAfter(parent, anchor, node) {
  const inPlace = node.parentNode === parent
    && (anchor ? anchor.nextSibling === node : parent.firstChild === node);
  if (!inPlace) { if (anchor) anchor.after(node); else parent.prepend(node); }
  return node;
}

// classList.toggle(name, false) materializes an empty class="" attribute on
// a class-less element — the flat restore must leave the pre-split DOM
// byte-identical, so only touch the attribute when the state changes.
function setClass(el, name, o) {
  if (el.classList.contains(name) === !!o) return;
  if (o) el.classList.add(name);
  else {
    el.classList.remove(name);
    if (!el.classList.length) el.removeAttribute("class"); // no empty class="" residue
  }
}

/** Project the editor-group `split` into the shell chrome, or restore the
 * flat single-strip layout.
 *   els     — { tabhost, tabstrip, tabbar, actionsEl, actionsHome, emptyEl }
 *             (actionsHome is #tab-actions' flat-state parent, #tabbar-row)
 *   on      — whether the split is the visible surface (false = flat)
 *   entries — the shell's ordered tab list: [id, { tabEl, paneEl }] in
 *             tab-creation order (the flat strip's order) */
export function projectSplitDom(els, split, on, entries) {
  const { tabhost, tabstrip, tabbar, actionsEl, actionsHome, emptyEl } = els;
  const doc = tabbar.ownerDocument;
  const focused = doc.activeElement;
  const active = on && !!split;
  setClass(tabhost, "split-row", active && split.orientation === "row");
  setClass(tabhost, "split-col", active && split.orientation === "col");
  setClass(tabstrip, "split-hidden", active);
  if (!active) {
    // put the controls back EXACTLY where they came from (marker swap —
    // the flat chrome must stay byte-identical to the pre-split DOM)
    if (actionsEl[MARKER]) {
      actionsEl[MARKER].replaceWith(actionsEl);
      actionsEl[MARKER] = null;
    } else if (actionsEl.parentNode !== actionsHome) actionsHome.append(actionsEl);
    emptyEl.remove();
    const cells = tabhost.querySelectorAll(":scope > .group-cell");
    if (cells.length) {
      for (const [, t] of entries) {
        tabbar.append(t.tabEl);           // creation order restored
        tabhost.append(t.paneEl);         // panes return to the host
      }
      for (const c of cells) c.remove();
    }
    if (focused && doc.activeElement !== focused
        && (tabbar.contains(focused) || tabhost.contains(focused))) focused.focus();
    return;
  }
  const byId = new Map(entries.map(([id, t]) => [id, t]));
  let cellAnchor = null;
  for (const group of split.groups) {
    const cell = ensureCell(tabhost, cellAnchor, group);
    cellAnchor = cell;
    const bar = cell.querySelector(":scope > .group-tabbar");
    let tabAnchor = null;
    for (const id of group.tabs) {
      const t = byId.get(id);
      if (!t) continue;
      tabAnchor = placeAfter(bar, tabAnchor, t.tabEl);
    }
    // the split controls live on the FOCUSED group's strip (VS Code style)
    if (group.id === split.focusedGroup && bar.lastChild !== actionsEl) {
      if (!actionsEl[MARKER] && actionsEl.parentNode === actionsHome) {
        actionsEl[MARKER] = doc.createComment("tab-actions");
        actionsEl.replaceWith(actionsEl[MARKER]);
      }
      bar.append(actionsEl);
    }
    // panes park inside their group's cell, after the strip, in group order
    let paneAnchor = bar;
    for (const id of group.tabs) {
      const t = byId.get(id);
      if (!t) continue;
      const inPlace = t.paneEl.parentNode === cell && paneAnchor.nextSibling === t.paneEl;
      if (!inPlace) paneAnchor.after(t.paneEl);
      paneAnchor = t.paneEl;
    }
    if (!group.tabs.length) {
      if (emptyEl.parentNode !== cell) cell.append(emptyEl);
    } else if (emptyEl.parentNode === cell) emptyEl.remove();
  }
  // groups that no longer exist: their cells disappear (panes/tabs of the
  // survivors were re-homed above; a closed tab's nodes are already gone)
  const live = new Set(split.groups.map((g) => String(g.id)));
  for (const c of tabhost.querySelectorAll(":scope > .group-cell")) {
    if (!live.has(c.dataset.group)) c.remove();
  }
  if (focused && doc.activeElement !== focused
      && (tabhost.contains(focused) || tabbar.contains(focused))) focused.focus();
}
