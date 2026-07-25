export function collapseKey(workspace, instance) {
  return `${workspace || ""}\u0000${instance}`;
}

export function hasInstanceChildren(instances, instance) {
  return instances.some((candidate) => candidate.parentInstance === instance);
}

export function instanceRepoLabel(instance) {
  if (instance.repoName) return instance.repoName;
  const path = instance.repo || instance.workspace || "";
  return String(path).split("/").filter(Boolean).at(-1) || "workspace";
}

/* ── roster grouping: repo → agent family (soul), with sort modes ── */

export const ROSTER_SORTS = [
  { id: "status", label: "Status (running first)" },
  { id: "name", label: "Name" },
];

/** Comparator for one sibling level. "status" ranks running instances first,
 * then by name; "name" is purely alphabetical. Unknown ids fall back to
 * "status" so a stale persisted choice can never break rendering. */
export function rosterRank(sortBy) {
  const byName = (a, b) => String(a.instance).localeCompare(String(b.instance));
  if (sortBy === "name") return byName;
  return (a, b) => (!!a.running === !!b.running ? byName(a, b) : a.running ? -1 : 1);
}

/** Group a roster list repo → agent family (soul), each family's items in
 * lineage order (parents before children, depth annotated) with siblings
 * sorted by `sortBy`. Lineage links crossing family/repo boundaries are cut:
 * such children render as roots of their own family group. Returns
 * Map<repoLabel, Map<familyName, item[]>> with deterministic group order:
 * repos and families alphabetical. */
export function groupRosterFamilies(list, sortBy = "status") {
  const rank = rosterRank(sortBy);
  const repos = new Map();
  for (const i of list) {
    const rName = instanceRepoLabel(i);
    if (!repos.has(rName)) repos.set(rName, new Map());
    const families = repos.get(rName);
    const fName = i.agent || "?";
    if (!families.has(fName)) families.set(fName, []);
    families.get(fName).push(i);
  }
  const sortedRepos = new Map([...repos.entries()].sort(([a], [b]) => a.localeCompare(b)));
  for (const [rName, families] of sortedRepos) {
    const sortedFamilies = new Map([...families.entries()].sort(([a], [b]) => a.localeCompare(b)));
    for (const [fName, items] of sortedFamilies) {
      const byName = new Map(items.map((i) => [i.instance, i]));
      const roots = items.filter((i) => !i.parentInstance || !byName.has(i.parentInstance));
      const kids = (p) => items.filter((i) => i.parentInstance === p.instance);
      const ordered = [];
      const seen = new Set();
      const walk = (i, depth) => {
        if (seen.has(i.instance)) return; // cycle-safe
        seen.add(i.instance);
        ordered.push({ ...i, depth });
        kids(i).sort(rank).forEach((k) => walk(k, depth + 1));
      };
      roots.sort(rank).forEach((r) => walk(r, 0));
      for (const i of items) if (!seen.has(i.instance)) ordered.push({ ...i, depth: 0 });
      sortedFamilies.set(fName, ordered);
    }
    sortedRepos.set(rName, sortedFamilies);
  }
  return sortedRepos;
}

/** Stable collapse key for a roster GROUP header (repo or repo+family),
 * workspace-scoped like instance collapse keys. */
export function rosterGroupKey(workspace, ...parts) {
  return [`g:${workspace || ""}`, ...parts].join("\u0000");
}

/** VS Code-style guide segments for one row in a flattened parent-first tree.
 * `continue` is an ancestor/sibling vertical; `branch` has a later sibling and
 * an elbow; `end` is the final sibling, stopping at its elbow; `none` suppresses
 * an exhausted ancestor line through deeper descendants. */
export function treeGuideSegments(items, item) {
  const byName = new Map(items.map((candidate) => [candidate.instance, candidate]));
  const chain = [];
  const seen = new Set();
  let cursor = item;
  while (cursor?.parentInstance && byName.has(cursor.parentInstance) && !seen.has(cursor.instance)) {
    seen.add(cursor.instance);
    chain.unshift(cursor);
    cursor = byName.get(cursor.parentInstance);
  }
  return chain.map((branch, index) => {
    const at = items.indexOf(branch);
    const hasLaterSibling = items.slice(at + 1)
      .some((candidate) => candidate.parentInstance === branch.parentInstance);
    const current = index === chain.length - 1;
    if (!current) return hasLaterSibling ? "continue" : "none";
    return hasLaterSibling ? "branch" : "end";
  });
}

/** Include matching instances plus their ancestor paths, in source order. */
export function filterInstanceTree(instances, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return instances;
  const byName = new Map(instances.map((item) => [item.instance, item]));
  const included = new Set();
  for (const item of instances) {
    const matches = [item.instance, item.agent, item.repoName, item.task]
      .some((value) => String(value || "").toLowerCase().includes(needle));
    if (!matches) continue;
    let cursor = item;
    const seen = new Set();
    while (cursor && !seen.has(cursor.instance)) {
      included.add(cursor.instance);
      seen.add(cursor.instance);
      cursor = byName.get(cursor.parentInstance);
    }
  }
  return instances.filter((item) => included.has(item.instance));
}

/** Whether an item remains visible under VS Code-style collapsed ancestors.
 * Filtering temporarily reveals matching paths without mutating the user's
 * persisted collapse state. Parent traversal is cycle-safe. */
export function instanceVisibleInTree(instance, allInstances, collapsed, workspace, filtering = false) {
  if (filtering) return true;
  const byName = new Map(allInstances.map((item) => [item.instance, item]));
  const seen = new Set([instance.instance]);
  let parentName = instance.parentInstance;
  while (parentName && !seen.has(parentName)) {
    if (collapsed.has(collapseKey(workspace, parentName))) return false;
    seen.add(parentName);
    parentName = byName.get(parentName)?.parentInstance;
  }
  return true;
}

/** Capture focus identity + scroll before a keyed rebuild and return a restore
 * callback. Both disclosure and terminal buttons carry these data attributes. */
export function captureTreeRenderState(listEl) {
  const active = listEl.ownerDocument.activeElement;
  const inside = active && listEl.contains(active);
  const identity = inside ? {
    instance: active.dataset.treeInstance,
    control: active.dataset.treeControl,
  } : null;
  const scrollTop = listEl.scrollTop;
  return () => {
    if (!identity?.instance || !identity?.control) {
      listEl.scrollTop = scrollTop;
      return false;
    }
    const replacement = [...listEl.querySelectorAll("[data-tree-instance][data-tree-control]")]
      .find((element) => element.dataset.treeInstance === identity.instance
        && element.dataset.treeControl === identity.control
        && !element.disabled);
    // Chromium normally scrolls focused controls into view. preventScroll is
    // the primary guard; restoring afterward is a fallback for older engines
    // and ensures row reordering cannot overwrite the user's saved position.
    replacement?.focus({ preventScroll: true });
    listEl.scrollTop = scrollTop;
    return listEl.ownerDocument.activeElement === replacement;
  };
}

/** Filtering force-expands matching paths. Its disclosure remains truthful but
 * inert, so clicking cannot mutate persisted collapse state invisibly. */
export function configureDisclosure(button, { instance, collapsed, filtering, onToggle }) {
  const expanded = filtering || !collapsed;
  button.dataset.treeInstance = instance;
  button.dataset.treeControl = "disclosure";
  button.textContent = expanded ? "▾" : "▸";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${instance}`);
  button.disabled = !!filtering;
  if (filtering) {
    button.setAttribute("aria-disabled", "true");
    button.title = "Filtering temporarily expands matching branches";
  } else {
    button.addEventListener("click", onToggle);
  }
}

/** A first-launch request dispatched with ws="" may complete before or after
 * another view silently adopts the same server-resolved workspace. Both are
 * owned; a real generation/workspace change is not. */
export function rosterResponseOwns({ dispatchWorkspace, responseWorkspace, currentWorkspace,
  dispatchGeneration, currentGeneration }) {
  if (dispatchGeneration !== currentGeneration) return false;
  return currentWorkspace === dispatchWorkspace
    || (!dispatchWorkspace && currentWorkspace === responseWorkspace);
}
