/* oas desktop — agent-cluster computation for the Active overview.
   Pure functions, no DOM: clusters are the connected components of the
   roster under parent/child (parentInstance) and sibling (siblingInstance)
   links. ALL reading of sibling data goes through siblingLinksOf() — the
   single seam for the kernel's field shape.
   Malformed data must never break the overview: unknown names are ignored,
   self-links are ignored, and cycles are harmless to a union-find. */

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
    first (running-heavy first, then by cluster name), then singletons.
    Each cluster: { name, instances, running, size }.
    - name: deterministic label — the root-most member's name (the member
      with no in-cluster parent that sorts first), so the same roster
      always produces the same cluster identity across refreshes.
    - instances: members in roster order (layout decides visual order). */
export function computeClusters(instances) {
  const list = (instances || []).filter((i) => i && i.instance);
  const index = new Map(list.map((i, at) => [i.instance, at]));

  // union-find over roster positions
  const up = list.map((_, at) => at);
  const find = (a) => { while (up[a] !== a) { up[a] = up[up[a]]; a = up[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) up[rb] = ra; };

  list.forEach((i, at) => {
    const p = i.parentInstance;
    if (p && p !== i.instance && index.has(p)) union(index.get(p), at);
    for (const s of siblingLinksOf(i)) if (index.has(s)) union(index.get(s), at);
  });

  const groups = new Map(); // root position -> members
  list.forEach((i, at) => {
    const r = find(at);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  const clusters = [...groups.values()].map((members) => {
    const names = new Set(members.map((m) => m.instance));
    // root-most: no parent inside the cluster; deterministic tiebreak by name
    const roots = members.filter((m) => !(m.parentInstance && m.parentInstance !== m.instance && names.has(m.parentInstance)));
    const label = (roots.length ? roots : members)
      .map((m) => m.instance).sort()[0];
    return {
      name: label,
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
    names, both present in the cluster, deduped regardless of declaration
    direction. Returns [{ a, b }] with a < b. */
export function siblingEdges(cluster) {
  const names = new Set(cluster.instances.map((i) => i.instance));
  const seen = new Set();
  const edges = [];
  for (const i of cluster.instances) {
    for (const s of siblingLinksOf(i)) {
      if (!names.has(s)) continue;
      const [a, b] = [i.instance, s].sort();
      const key = `${a}\u0000${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b });
    }
  }
  return edges;
}
