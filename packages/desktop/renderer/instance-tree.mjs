export function collapseKey(workspace, instance) {
  return `${workspace || ""}\u0000${instance}`;
}

/** Names an instance is directly related to (undirected edge endpoints):
 * its spawn parent plus any sibling links. The sibling field name is owned
 * by the kernel contract (feature/agent-relations); until the final name is
 * relayed we read the likely shapes defensively — an array of names
 * (`siblingInstances`/`siblings`) or a single name (`siblingInstance`).
 * Unknown/absent fields simply contribute no edges. */
export function instanceLinks(instance) {
  const out = [];
  if (instance.parentInstance) out.push(instance.parentInstance);
  const sib = instance.siblingInstances ?? instance.siblings ?? instance.siblingInstance;
  for (const name of Array.isArray(sib) ? sib : sib ? [sib] : []) if (name) out.push(name);
  return out.filter((name) => name && name !== instance.instance);
}

/** Group instances into agent CLUSTERS — connected components of the
 * undirected relation graph (parent/child spawn edges + sibling links).
 * Unrelated instances are single-node clusters. Within a cluster the
 * parent/child tree ordering is kept (parent-first walk with depth);
 * cluster members related only by sibling links sit at depth 0.
 * Returns [{ key, instances: [{...instance, depth}] }] with clusters ranked
 * running-first then by first member name, matching the roster sort. */
export function clusterInstances(instances, { links = instanceLinks } = {}) {
  const byName = new Map(instances.map((i) => [i.instance, i]));
  // undirected adjacency — edges to names outside this roster are ignored
  const adj = new Map(instances.map((i) => [i.instance, new Set()]));
  for (const i of instances) {
    for (const other of links(i)) {
      if (!byName.has(other)) continue;
      adj.get(i.instance).add(other);
      adj.get(other).add(i.instance);
    }
  }
  const rank = (a, b) => (a.running === b.running ? a.instance.localeCompare(b.instance) : a.running ? -1 : 1);
  const seen = new Set();
  const clusters = [];
  for (const start of [...instances].sort(rank)) {
    if (seen.has(start.instance)) continue;
    // collect the component
    const members = [];
    const queue = [start.instance];
    seen.add(start.instance);
    while (queue.length) {
      const name = queue.shift();
      members.push(byName.get(name));
      for (const next of adj.get(name) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    // parent-first tree order INSIDE the component (cycle-safe: the walk
    // visits each member once; leftovers append at depth 0)
    const memberNames = new Set(members.map((i) => i.instance));
    const kids = (p) => members.filter((i) => i.parentInstance === p.instance);
    const roots = members.filter((i) => !i.parentInstance || !memberNames.has(i.parentInstance));
    roots.sort(rank);
    const ordered = [];
    const placed = new Set();
    const walk = (i, depth) => {
      if (placed.has(i.instance)) return;
      placed.add(i.instance);
      ordered.push({ ...i, depth });
      kids(i).sort(rank).forEach((k) => walk(k, depth + 1));
    };
    roots.forEach((r) => walk(r, 0));
    for (const i of [...members].sort(rank)) walk(i, 0); // malformed cycles must not hide members
    clusters.push({ key: ordered[0].instance, instances: ordered });
  }
  return clusters;
}

export function hasInstanceChildren(instances, instance) {
  return instances.some((candidate) => candidate.parentInstance === instance);
}

export function instanceRepoLabel(instance) {
  if (instance.repoName) return instance.repoName;
  const path = instance.repo || instance.workspace || "";
  return String(path).split("/").filter(Boolean).at(-1) || "workspace";
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
