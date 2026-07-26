// Split-pane DOM projection — the testable layer between the pure split
// model (split-layout.mjs) and the shell. Two projections live here:
//
//  * renderSplitLayout — member tab panes become flex cells of #tabhost in
//    MEMBER ORDER (members[0] is the tab that was active when the split was
//    requested — the current tab seeds the first pane), with the single
//    empty-slot placeholder after the last member while `pending > 0`.
//
//  * projectTabStrip — the tab strip visually reflects the split (editor-
//    group style): each member's REAL tab element (one chrome per tab, so
//    tab-a11y roving/aria/close semantics are untouched) moves into a
//    `.tab-group` sized like its pane, in pane order. Mapping: for
//    orientation "row" the groups share the strip width equally exactly as
//    the panes share #tabhost, so each group sits over its pane; for "col"
//    (stacked panes) group order left→right equals pane order top→bottom
//    (documented mapping — a horizontal strip cannot align with vertical
//    panes literally). A pending slot renders an empty spacer group over
//    the placeholder pane; tabs that are NOT split members keep their
//    normal look in a trailing non-flex group (still clickable — activating
//    one covers the split). Non-split state never touches the strip.
//
// Both projections are idempotent and move a node only when it is out of
// place: re-inserting an already-placed element would tear it out of the
// DOM mid-interaction (renderSplit runs from activateTab, which pane
// pointerdown triggers — review 156cbc7 lineage). Moving the focused tab
// trigger between containers can drop focus to <body>; restore it by node.

/** Project `split` members into `host` (#tabhost) as ordered flex cells.
 * `getPane(id)` resolves a member's pane element (null for a gone tab);
 * `emptyEl` is the shell's single pending-slot placeholder. */
export function renderSplitLayout(host, emptyEl, split, on, getPane) {
  const active = on && !!split;
  host.classList.toggle("split-row", active && split.orientation === "row");
  host.classList.toggle("split-col", active && split.orientation === "col");
  if (!active) { emptyEl.remove(); return; }
  let anchor = null; // last correctly-placed element
  for (const id of split.members) {
    const paneEl = getPane(id);
    if (!paneEl) continue;
    const inPlace = paneEl.parentNode === host && (anchor ? anchor.nextSibling === paneEl : true);
    if (!inPlace) {
      if (anchor) anchor.after(paneEl); else host.append(paneEl);
    }
    anchor = paneEl;
  }
  if (split.pending > 0) {
    if (emptyEl.previousSibling !== anchor || emptyEl.parentNode !== host) {
      if (anchor) anchor.after(emptyEl); else host.append(emptyEl);
    }
  } else emptyEl.remove();
}

function ensureGroup(tabbar, before, key, className) {
  let group = tabbar.querySelector(`:scope > .tab-group[data-group="${key}"]`);
  if (!group) {
    group = tabbar.ownerDocument.createElement("div");
    group.className = className;
    group.dataset.group = key;
    group.setAttribute("role", "presentation");
  }
  if (before ? before.nextSibling !== group : tabbar.firstChild !== group) {
    if (before) before.after(group); else tabbar.prepend(group);
  }
  return group;
}

/** Group the strip to match `split` (see module comment), or restore the
 * flat strip. `entries` is the shell's ordered tab list: [id, { tabEl }] in
 * tab-creation order (the flat strip's order). */
export function projectTabStrip(tabbar, split, on, entries) {
  const doc = tabbar.ownerDocument;
  const focused = doc.activeElement;
  const grouped = tabbar.classList.contains("split-strip");
  const active = on && !!split;
  if (!active) {
    if (!grouped) return; // non-split strip renders exactly as before splits existed
    tabbar.classList.remove("split-strip", "split-strip-col");
    for (const [, t] of entries) tabbar.append(t.tabEl); // creation order restored
    for (const g of tabbar.querySelectorAll(":scope > .tab-group")) g.remove();
    if (focused && doc.activeElement !== focused && tabbar.contains(focused)) focused.focus();
    return;
  }
  tabbar.classList.add("split-strip");
  tabbar.classList.toggle("split-strip-col", split.orientation === "col");
  const byId = new Map(entries.map(([id, t]) => [id, t]));
  let anchor = null;
  for (const id of split.members) {
    const t = byId.get(id);
    if (!t) continue;
    const group = ensureGroup(tabbar, anchor, `pane:${id}`, "tab-group tab-group-pane");
    if (t.tabEl.parentNode !== group) group.append(t.tabEl);
    anchor = group;
  }
  const pendingGroup = tabbar.querySelector(':scope > .tab-group[data-group="pending"]');
  if (split.pending > 0) {
    ensureGroup(tabbar, anchor, "pending", "tab-group tab-group-pane tab-group-pending")
      .setAttribute("aria-hidden", "true");
    anchor = tabbar.querySelector(':scope > .tab-group[data-group="pending"]');
  } else pendingGroup?.remove();
  const rest = ensureGroup(tabbar, anchor, "rest", "tab-group tab-group-rest");
  for (const [id, t] of entries) {
    if (split.members.includes(id)) continue;
    if (t.tabEl.parentNode !== rest) rest.append(t.tabEl);
  }
  // stale pane groups (member closed) disappear with their member
  for (const g of tabbar.querySelectorAll(":scope > .tab-group[data-group^='pane:']")) {
    const id = Number(g.dataset.group.slice(5));
    if (!split.members.includes(id)) g.remove();
  }
  if (focused && doc.activeElement !== focused && tabbar.contains(focused)) focused.focus();
}
