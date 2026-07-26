/* oas desktop — agent-cluster computation for the Active overview.
   Pure functions, no DOM: clusters are the connected components of the
   roster under parent/child (parentInstance) and sibling (siblingInstance)
   links. ALL reading of sibling data goes through siblingLinksOf() — the
   single seam for the kernel's field shape.
   IDENTITY: nodes are keyed by instanceId (composite identity from
   instance-tree.mjs), never bare name — duplicate instance names across
   agent dirs/team repos are legal, and a bare-name key would silently drop
   or falsely merge live instances (merged-state review f7c5769). Relation
   names resolve through the shared resolveLinkId semantics: same-agentsRoot
   first, unique cross-root allowed, ambiguous → no edge (fail safe).
   Malformed data must never break the overview: unknown names are ignored,
   self-links are ignored, and cycles are harmless to a union-find. */
import { instanceId, resolveLinkId } from "../instance-tree.mjs";

/** Sibling links of a roster instance, as an array of instance names.
    ADAPTER: kernel contract (final, relayed by dev-coordinator-parallel) is
    `siblingInstance`: string | absent — set only when a sibling relation
    was declared against a ROOT instance (a sibling of a non-root simply
    shares the anchor's parentInstance). Normalized to an array so callers
    are shape-agnostic; self-links and non-strings are dropped. */
export function siblingLinksOf(inst) {
  const raw = inst.siblingInstance;
  if (typeof raw !== "string" || !raw || raw === inst.instance) return [];
  return [raw];
}

/** Connected components of the roster under parent/child + sibling links.
    Returns clusters sorted for stable rendering: multi-member clusters
    first (running-heavy first, then by cluster key), then singletons.
    Each cluster: { name, instances, running, size }.
    - name: INTERNAL deterministic grouping/ordering key (root-most member's
      id), never rendered (clusters are anonymous by human decision).
    - instances: members in roster order (layout decides visual order). */
export function computeClusters(instances) {
  const list = (instances || []).filter((i) => i && i.instance);
  const ids = list.map((i) => instanceId(i));
  const index = new Map(ids.map((id, at) => [id, at])); // id -> roster position
  const byName = new Map();
  for (const i of list) {
    if (!byName.has(i.instance)) byName.set(i.instance, []);
    byName.get(i.instance).push(i);
  }

  // union-find over roster positions; edges resolve through the SHARED
  // resolver (same-root first, unique cross-root, ambiguous → dropped)
  const up = list.map((_, at) => at);
  const find = (a) => { while (up[a] !== a) { up[a] = up[up[a]]; a = up[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) up[rb] = ra; };
  const linkTo = (i, at, name) => {
    const oid = resolveLinkId(i, name, byName);
    if (oid && oid !== ids[at] && index.has(oid)) union(index.get(oid), at);
  };
  list.forEach((i, at) => {
    if (i.parentInstance) linkTo(i, at, i.parentInstance);
    for (const s of siblingLinksOf(i)) linkTo(i, at, s);
  });

  const groups = new Map(); // component root position -> members
  list.forEach((i, at) => {
    const r = find(at);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  const clusters = [...groups.values()].map((members) => {
    const memberIds = new Set(members.map((m) => instanceId(m)));
    // root-most: no RESOLVED parent inside the cluster; deterministic tiebreak
    const roots = members.filter((m) => {
      const pid = m.parentInstance ? resolveLinkId(m, m.parentInstance, byName) : null;
      return !(pid && pid !== instanceId(m) && memberIds.has(pid));
    });
    const key = (roots.length ? roots : members)
      .map((m) => instanceId(m)).sort()[0];
    return {
      name: key,
      instances: members,
      running: members.filter((m) => m.running).length,
      size: members.length,
    };
  });

  clusters.sort((a, b) => {
    const aSingle = a.size === 1 ? 1 : 0, bSingle = b.size === 1 ? 1 : 0;
    if (aSingle !== bSingle) return aSingle - bSingle;   // multi-member first
    if (a.running !== b.running) return b.running - a.running;
    return a.name.localeCompare(b.name);
  });
  return clusters;
}

/** Sibling edge list within one cluster: unique unordered pairs of member
    instanceIds, both resolved into the cluster, deduped regardless of
    declaration direction. rosterByName (name -> instance[]) SHOULD be the
    FULL roster's index — resolving against only the cluster's members can
    make a globally-ambiguous name falsely unique and reintroduce a dropped
    edge (review 3ab2a40); defaults to cluster scope only for callers with
    no wider roster. Returns [{ a, b }] with a < b (ids). */
export function siblingEdges(cluster, rosterByName) {
  const memberIds = new Set(cluster.instances.map((i) => instanceId(i)));
  let byName = rosterByName;
  if (!byName) {
    byName = new Map();
    for (const i of cluster.instances) {
      if (!byName.has(i.instance)) byName.set(i.instance, []);
      byName.get(i.instance).push(i);
    }
  }
  const seen = new Set();
  const edges = [];
  for (const i of cluster.instances) {
    for (const s of siblingLinksOf(i)) {
      const oid = resolveLinkId(i, s, byName);
      if (!oid || !memberIds.has(oid)) continue;
      const [a, b] = [instanceId(i), oid].sort();
      const key = `${a}\u0000${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b });
    }
  }
  return edges;
}
