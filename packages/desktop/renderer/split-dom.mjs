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
//    `.tab-group` inside the dedicated `paneTabs` row, in pane order.
//    ALIGNMENT INVARIANT (review 59fa415): the pane groups must divide the
//    SAME width the panes divide — so they live in their own full-width
//    strip row (`#pane-tabs`, a sibling of #tabhost's column with no other
//    flex content), never sharing a track with the split-control buttons
//    or with non-member tabs. For orientation "row" the equal flex shares
//    of that row match the panes' equal shares of #tabhost exactly; for
//    "col" (stacked panes) group order left→right equals pane order
//    top→bottom (documented mapping — a horizontal strip cannot align with
//    vertical panes literally). A pending slot renders an empty spacer
//    group over the placeholder pane; tabs that are NOT split members keep
//    their normal look in the ordinary tabbar row below (still clickable —
//    activating one covers the split). Non-split state never touches
//    either row.
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

function ensureGroup(paneTabs, before, key, className) {
  let group = paneTabs.querySelector(`:scope > .tab-group[data-group="${key}"]`);
  if (!group) {
    group = paneTabs.ownerDocument.createElement("div");
    group.className = className;
    group.dataset.group = key;
    group.setAttribute("role", "presentation");
  }
  if (before ? before.nextSibling !== group : paneTabs.firstChild !== group) {
    if (before) before.after(group); else paneTabs.prepend(group);
  }
  return group;
}

/** Group the strip to match `split` (see module comment), or restore the
 * flat strip. `paneTabs` is the dedicated full-width row for member-tab
 * groups (its width track equals #tabhost's); `tabbar` is the ordinary
 * strip row where non-members stay. `entries` is the shell's ordered tab
 * list: [id, { tabEl }] in tab-creation order (the flat strip's order). */
export function projectTabStrip(paneTabs, tabbar, split, on, entries) {
  const doc = tabbar.ownerDocument;
  const focused = doc.activeElement;
  const active = on && !!split;
  if (!active) {
    if (paneTabs.hidden && !paneTabs.childNodes.length) return; // already flat
    paneTabs.hidden = true;
    paneTabs.classList.remove("split-strip-col");
    for (const [, t] of entries) tabbar.append(t.tabEl); // creation order restored
    for (const g of paneTabs.querySelectorAll(":scope > .tab-group")) g.remove();
    if (focused && doc.activeElement !== focused && tabbar.contains(focused)) focused.focus();
    return;
  }
  paneTabs.hidden = false;
  paneTabs.classList.toggle("split-strip-col", split.orientation === "col");
  const byId = new Map(entries.map(([id, t]) => [id, t]));
  let anchor = null;
  for (const id of split.members) {
    const t = byId.get(id);
    if (!t) continue;
    const group = ensureGroup(paneTabs, anchor, `pane:${id}`, "tab-group tab-group-pane");
    if (t.tabEl.parentNode !== group) group.append(t.tabEl);
    anchor = group;
  }
  const pendingGroup = paneTabs.querySelector(':scope > .tab-group[data-group="pending"]');
  if (split.pending > 0) {
    ensureGroup(paneTabs, anchor, "pending", "tab-group tab-group-pane tab-group-pending")
      .setAttribute("aria-hidden", "true");
  } else pendingGroup?.remove();
  // non-members keep their flat look in the ordinary tabbar row
  for (const [id, t] of entries) {
    if (split.members.includes(id)) continue;
    if (t.tabEl.parentNode !== tabbar) tabbar.append(t.tabEl);
  }
  // stale pane groups (member closed) disappear with their member
  for (const g of paneTabs.querySelectorAll(":scope > .tab-group[data-group^='pane:']")) {
    const id = Number(g.dataset.group.slice(5));
    if (!split.members.includes(id)) g.remove();
  }
  if (focused && doc.activeElement !== focused
      && (paneTabs.contains(focused) || tabbar.contains(focused))) focused.focus();
}
