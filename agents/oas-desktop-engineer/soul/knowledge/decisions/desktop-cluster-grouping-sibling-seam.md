---
type: Decision
title: Desktop cluster grouping consumes the final siblingInstance seam
description: Desktop cluster grouping computes connected components over parentInstance plus the final root-sibling siblingInstance field, threaded through instanceLinks() and the server projection without changing the grouping algorithm.
tags: [desktop, agent-relations, clusters]
timestamp: 2026-07-25
---

The desktop sidebar groups running and idle instances by agent cluster: the connected component of the undirected relation graph made from spawn parentage plus sibling links.

The final kernel contract is captured in [Final kernel contract for spawn-time agent relations](/references/agent-relations-kernel-contract.md): `parentInstance` is unchanged, `siblingInstance` is a string only for sibling relations declared against a root instance, `relation` records `"child"`, `"sibling"`, or `"parent"`, and `relativeTo` records the spawn anchor.

The desktop side keeps the original pluggable seam: `instanceLinks(instance)` in `packages/desktop/renderer/instance-tree.mjs` is the single extractor, and `clusterInstances(list, { links })` also accepts an injected extractor for tests. The shipped `/api/panel` projection in `packages/desktop/server/oas-web.mjs` explicitly allowlists `siblingInstance`, `relation`, and `relativeTo` from roster metadata; `instanceLinks(instance)` consumes `parentInstance` and `siblingInstance` without changing the connected-component grouping algorithm.

Within a cluster, parent-first tree order with depth is preserved; sibling-only members sit at depth 0; malformed parent cycles keep all members visible by walking once and appending leftovers, mirroring `model.mjs` `buildConstellation` defensive handling.
