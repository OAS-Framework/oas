export function collapseKey(workspace, instance) {
  return `${workspace || ""}\u0000${instance}`;
}

export function hasInstanceChildren(instances, instance) {
  return instances.some((candidate) => candidate.parentInstance === instance);
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
    listEl.scrollTop = scrollTop;
    if (!identity?.instance || !identity?.control) return false;
    const replacement = [...listEl.querySelectorAll("[data-tree-instance][data-tree-control]")]
      .find((element) => element.dataset.treeInstance === identity.instance
        && element.dataset.treeControl === identity.control
        && !element.disabled);
    replacement?.focus();
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
