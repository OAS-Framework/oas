export function collapseKey(workspace, instance) {
  return `${workspace || ""}\u0000${instance}`;
}

/** Names an instance is directly related to (undirected edge endpoints):
 * its spawn parent plus its explicit sibling link. Kernel contract
 * (feature/agent-relations, final): `parentInstance` and `siblingInstance`
 * (string, only set when a sibling relation was declared against a ROOT
 * instance — a sibling of a non-root simply shares the anchor's parent).
 * Absent fields contribute no edges. */
export function instanceLinks(instance) {
  const out = [];
  if (instance.parentInstance) out.push(instance.parentInstance);
  if (instance.siblingInstance) out.push(instance.siblingInstance);
  return out.filter((name) => name && name !== instance.instance);
}

/** Stable identity for one roster instance. Instance NAMES are only unique
 * within one agents root — the kernel permits duplicate names across agent
 * dirs/team repos — so graph code must never key nodes by bare name (a
 * duplicate would silently hide a live instance; merged-state review
 * f7c5769). The canonical home path is unique per instance; agentsRoot+name
 * is the fallback; bare name only when the roster carries neither. */
export function instanceId(instance) {
  if (instance.home) return String(instance.home);
  if (instance.agentsRoot) return `${instance.agentsRoot}\u0000${instance.instance}`;
  return String(instance.instance);
}

/** Resolve one relation-edge NAME to the id of the instance it means.
 * Relation names come from instance.json lineage, which is recorded within
 * one deployment scope — so a name resolves to the same-agentsRoot instance
 * first; a name that is globally unique resolves cross-root; an AMBIGUOUS
 * name — no same-root candidate, or MORE THAN ONE same-root candidate
 * (intra-root duplicates are legal and inherently ambiguous; merged-state
 * review @7dd1e7b) — resolves to nothing (fail safe: two separate clusters,
 * never a wrong merge, a false edge, or a hidden node).
 * EXPORTED as the one shared resolver — ux-designer's hierarchy/cluster
 * maps must use the same semantics rather than re-implementing them.
 * byName: Map<name, instance[]> over the same roster. */
export function resolveLinkId(fromInstance, name, byName) {
  const candidates = byName.get(name);
  if (!candidates || !candidates.length) return null;
  if (candidates.length === 1) return instanceId(candidates[0]);
  const sameRoot = candidates.filter((c) => c.agentsRoot && c.agentsRoot === fromInstance.agentsRoot);
  return sameRoot.length === 1 ? instanceId(sameRoot[0]) : null;
}

/** Group instances into agent CLUSTERS — connected components of the
 * undirected relation graph (parent/child spawn edges + sibling links).
 * Unrelated instances are single-node clusters. Within a cluster the
 * parent/child tree ordering is kept (parent-first walk with depth);
 * cluster members related only by sibling links sit at depth 0.
 * Nodes are keyed by instanceId (composite identity), never bare name —
 * duplicate names across repos render as distinct nodes.
 * Returns [{ key, instances: [{...instance, depth}] }] with clusters ranked
 * running-first then by first member name, matching the roster sort. */
export function clusterInstances(instances, { links = instanceLinks } = {}) {
  const byId = new Map(instances.map((i) => [instanceId(i), i]));
  const byName = new Map();
  for (const i of instances) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  // undirected adjacency over IDs — unresolvable/ambiguous edges are ignored
  const adj = new Map(instances.map((i) => [instanceId(i), new Set()]));
  const parentIdOf = new Map(); // id -> resolved parent id (tree ordering)
  for (const i of instances) {
    const id = instanceId(i);
    if (i.parentInstance) {
      const pid = resolveLinkId(i, i.parentInstance, byName);
      if (pid && pid !== id) parentIdOf.set(id, pid);
    }
    for (const other of links(i)) {
      const oid = resolveLinkId(i, other, byName);
      if (!oid || oid === id) continue;
      adj.get(id).add(oid);
      adj.get(oid).add(id);
    }
  }
  const rank = (a, b) => (a.running === b.running ? a.instance.localeCompare(b.instance) : a.running ? -1 : 1);
  const seen = new Set();
  const clusters = [];
  for (const start of [...instances].sort(rank)) {
    if (seen.has(instanceId(start))) continue;
    // collect the component
    const members = [];
    const queue = [instanceId(start)];
    seen.add(instanceId(start));
    while (queue.length) {
      const id = queue.shift();
      members.push(byId.get(id));
      for (const next of adj.get(id) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    // parent-first tree order INSIDE the component (cycle-safe: the walk
    // visits each member once; leftovers append at depth 0)
    const memberIds = new Set(members.map(instanceId));
    const kids = (p) => members.filter((i) => parentIdOf.get(instanceId(i)) === instanceId(p));
    const roots = members.filter((i) => {
      const pid = parentIdOf.get(instanceId(i));
      return !pid || !memberIds.has(pid);
    });
    roots.sort(rank);
    const ordered = [];
    const placed = new Set();
    const walk = (i, depth) => {
      if (placed.has(instanceId(i))) return;
      placed.add(instanceId(i));
      ordered.push({ ...i, depth });
      kids(i).sort(rank).forEach((k) => walk(k, depth + 1));
    };
    roots.forEach((r) => walk(r, 0));
    for (const i of [...members].sort(rank)) walk(i, 0); // malformed cycles must not hide members
    // Deterministic cluster label: the lexically-smallest ROOT name —
    // independent of liveness, so the visible cluster name does not flip
    // when a different member starts/stops running (review f921f7d nit).
    // Running-first `rank` still governs display ORDER within the cluster.
    const rootNames = (roots.length ? roots : members).map((i) => i.instance).sort();
    clusters.push({ key: rootNames[0], instances: ordered });
  }
  return clusters;
}

/** Anonymous cluster boundary for the instances sidebar (human re-test on
 * feature/agent-relations): NO visible glyph or name — the group reads from
 * spacing — but the element keeps role=separator + an aria-label with the
 * member count so AT users still get the boundary. Importable so the
 * regression exercises the exact builder the shell uses. */
export function clusterSeparator(doc, memberCount) {
  const el = doc.createElement("div");
  el.className = "ctx-cluster-sep";
  el.setAttribute("role", "separator");
  el.setAttribute("aria-label", `Agent cluster of ${memberCount} related instances`);
  return el;
}

/** Find the roster instance a UI reference means. References carry the
 * display name plus whatever identity the caller knows (home/agentsRoot —
 * sidebar rows know both; older callers pass a bare name). Identity match
 * wins; bare names resolve only when unambiguous in the roster — an
 * ambiguous bare name returns null rather than the first same-named match
 * (which could open the WRONG agents root's tmux session; review 46f3fdc).
 * Importable so the duplicate-name regression exercises this exact layer. */
export function findRosterInstance(instances, ref) {
  const name = typeof ref === "string" ? ref : ref.instance;
  const home = typeof ref === "string" ? undefined : ref.home;
  const root = typeof ref === "string" ? undefined : ref.agentsRoot;
  if (home) {
    const byHome = instances.find((i) => i.home === home);
    if (byHome) return byHome;
  }
  if (root) {
    const byRoot = instances.find((i) => i.instance === name && i.agentsRoot === root);
    if (byRoot) return byRoot;
  }
  const named = instances.filter((i) => i.instance === name);
  return named.length === 1 ? named[0] : null;
}

/** Terminal-tab dedup key for an instance reference: workspace-scoped and
 * IDENTITY-scoped, so two same-named instances from different agents roots
 * are different terminals (review 46f3fdc). Bare-name refs key by name
 * (legacy callers; findRosterInstance already refuses ambiguous names). */
export function terminalKey(workspace, ref) {
  const id = typeof ref === "string" ? ref : instanceId(ref);
  return `term:${workspace}:${id}`;
}

/** Shortest DISTINGUISHING path suffixes for a set of agents roots.
 * Duplicate instance names are told apart by where they home, but naive
 * single-segment tags collide (/a/project/agents and /b/project/agents both
 * render "project"). Grow each root's suffix segment-by-segment until it is
 * unique within the set; fall back to the full root. Returns Map<root, tag>.
 * (Review cbd5bb3: duplicate option labels must actually differ.) */
export function distinguishingRootTags(roots) {
  const uniq = [...new Set(roots.filter(Boolean).map(String))];
  const segs = new Map(uniq.map((r) => [r, r.split("/").filter(Boolean)]));
  const tags = new Map();
  for (const root of uniq) {
    const mine = segs.get(root);
    // skip the trailing "agents"-style leaf shared by every root: start the
    // suffix ABOVE the leaf, then extend upward until unique
    let take = 2; // leaf + one parent
    let tag;
    for (; take <= mine.length; take++) {
      tag = mine.slice(-take, -1).join("/");
      const clash = uniq.some((other) => other !== root
        && segs.get(other).slice(-take, -1).join("/") === tag);
      if (!clash) break;
    }
    tags.set(root, take > mine.length || !tag ? root : tag);
  }
  return tags;
}

/** Resolve a terminal-open reference and mint its canonical dedup key — in
 * that ORDER (review 7d740f9): the key must derive from the RESOLVED roster
 * instance, never the caller's ref shape, so a bare-name open and a sidebar
 * object open of the same identity share one tab, and a stale bare-name
 * tab can never be activated once the name has become ambiguous (resolution
 * refuses first). Returns { inst, key } or { error: "ambiguous"|"unknown" }.
 * Importable so the ordering regression exercises this exact layer. */
export function resolveTerminalOpen(instances, ref, workspace) {
  const name = typeof ref === "string" ? ref : ref.instance;
  const inst = findRosterInstance(instances, ref);
  if (!inst) {
    const dup = instances.filter((i) => i.instance === name).length > 1;
    return { error: dup ? "ambiguous" : "unknown", name };
  }
  return { inst, key: terminalKey(workspace, inst), name };
}

/** Whether an instance has children IN ITS OWN identity — parent edges
 * resolve through resolveLinkId, so a childless parent whose NAME is shared
 * by a parent in another agents root gets no disclosure control (review
 * 7d740f9). Accepts the full instance object; the legacy bare-name call
 * shape (string) keeps name matching for rosters without identity fields. */
export function hasInstanceChildren(instances, instance) {
  if (typeof instance === "string") {
    return instances.some((candidate) => candidate.parentInstance === instance);
  }
  const byName = new Map();
  for (const i of instances) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }
  const id = instanceId(instance);
  return instances.some((candidate) => candidate.parentInstance
    && resolveLinkId(candidate, candidate.parentInstance, byName) === id);
}

export function instanceRepoLabel(instance) {
  if (instance.repoName) return String(instance.repoName);
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
    // instance.json is workspace-controlled: agent/repoName may arrive as
    // non-strings through the reader. Coerce grouping keys so one malformed
    // instance cannot throw in localeCompare and blank the whole roster.
    const rName = String(instanceRepoLabel(i));
    if (!repos.has(rName)) repos.set(rName, new Map());
    const families = repos.get(rName);
    const fName = String(i.agent || "?");
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

/** Include matching instances plus their ancestor paths, in source order.
 * IDENTITY-aware (merged-state review @3e76616): inclusion keys by
 * instanceId and ancestors resolve through resolveLinkId over the FULL
 * roster — a same-named instance in another root never leaks into this
 * one's filter results, and an ambiguous parent edge includes nothing. */
export function filterInstanceTree(instances, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return instances;
  const byId = new Map(instances.map((item) => [instanceId(item), item]));
  const byName = new Map();
  for (const item of instances) {
    if (!byName.has(item.instance)) byName.set(item.instance, []);
    byName.get(item.instance).push(item);
  }
  const included = new Set();
  for (const item of instances) {
    const matches = [item.instance, item.agent, item.repoName, item.task]
      .some((value) => String(value || "").toLowerCase().includes(needle));
    if (!matches) continue;
    let cursor = item;
    const seen = new Set();
    while (cursor) {
      const id = instanceId(cursor);
      if (seen.has(id)) break;
      included.add(id);
      seen.add(id);
      const pid = cursor.parentInstance ? resolveLinkId(cursor, cursor.parentInstance, byName) : null;
      cursor = pid ? byId.get(pid) : null;
    }
  }
  return instances.filter((item) => included.has(instanceId(item)));
}

/** Cluster the FULL roster, then project each cluster to its visible
 * members — never cluster a filtered subset: dropping roster rows can turn
 * a globally AMBIGUOUS relation edge into a false unique edge, silently
 * re-linking nodes while the user types (merged-state review @3e76616).
 * Cluster order and member depths come from the full-roster computation;
 * clusters with no visible member disappear. */
export function visibleClusters(allInstances, visibleInstances, { links = instanceLinks } = {}) {
  const visibleIds = new Set(visibleInstances.map((i) => instanceId(i)));
  return clusterInstances(allInstances, { links })
    .map((c) => ({ ...c, instances: c.instances.filter((i) => visibleIds.has(instanceId(i))) }))
    .filter((c) => c.instances.length);
}

/** Whether an item remains visible under VS Code-style collapsed ancestors.
 * Filtering temporarily reveals matching paths without mutating the user's
 * persisted collapse state. Parent traversal is cycle-safe. */
/** Whether an item remains visible under VS Code-style collapsed ancestors.
 * Filtering temporarily reveals matching paths without mutating the user's
 * persisted collapse state. Parent traversal is cycle-safe and
 * IDENTITY-aware: collapse keys are minted from instanceId, and parent
 * names resolve through resolveLinkId so a collapsed duplicate name in
 * another agents root can never hide this root's subtree (review 46f3fdc). */
export function instanceVisibleInTree(instance, allInstances, collapsed, workspace, filtering = false) {
  if (filtering) return true;
  const byId = new Map(allInstances.map((item) => [instanceId(item), item]));
  const byName = new Map();
  for (const item of allInstances) {
    if (!byName.has(item.instance)) byName.set(item.instance, []);
    byName.get(item.instance).push(item);
  }
  const seen = new Set([instanceId(instance)]);
  let cursor = instance;
  while (cursor?.parentInstance) {
    const pid = resolveLinkId(cursor, cursor.parentInstance, byName);
    if (!pid || seen.has(pid)) break;
    if (collapsed.has(collapseKey(workspace, pid))) return false;
    seen.add(pid);
    cursor = byId.get(pid);
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
export function configureDisclosure(button, { instance, label, collapsed, filtering, onToggle }) {
  const expanded = filtering || !collapsed;
  button.dataset.treeInstance = instance;
  button.dataset.treeControl = "disclosure";
  button.textContent = expanded ? "▾" : "▸";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${label || instance}`);
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
