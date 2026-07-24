export function collapseKey(workspace, instance) {
  return `${workspace || ""}\u0000${instance}`;
}

export function hasInstanceChildren(instances, instance) {
  return instances.some((candidate) => candidate.parentInstance === instance);
}

/** Whether an item remains visible under VS Code-style collapsed ancestors.
 * Filtering temporarily reveals matching descendants without mutating the
 * user's persisted collapse state. Parent traversal is cycle-safe. */
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
