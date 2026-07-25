---
type: Decision
title: Desktop cluster grouping uses a pluggable sibling-link extractor until the kernel field name lands
description: Desktop cluster grouping computes connected components over parentage plus a single sibling-link extractor seam, so the eventual kernel sibling field name should integrate through that extractor and the server projection without changing the grouping algorithm.
tags: [desktop, agent-relations, clusters]
timestamp: 2026-07-25
---

For feature/agent-relations, the sidebar and Instances roster group by agent
cluster: the connected component of the undirected relation graph made from
spawn parentage plus sibling links.

The kernel's sibling field name in `oas status --json` was not final when the
desktop side was built, so `instanceLinks(instance)` in
`packages/desktop/renderer/instance-tree.mjs` is the single desktop seam. It
reads `parentInstance` plus likely sibling shapes (`siblingInstances` array,
`siblings` array, and `siblingInstance` string), dropping self, empty, and
dangling links. `clusterInstances(list, { links })` also accepts an injected
extractor for tests.

When the coordinator relays the real field name, update:

1. `instanceLinks(instance)`; and
2. the server's `/api/panel` projection in `server/oas-web.mjs`, which must
   forward the field from roster metadata.

Nothing else in the grouping algorithm should change for that rename.

Within a cluster, parent-first tree order with depth is preserved;
sibling-only members sit at depth 0; malformed parent cycles keep all members
visible by walking once and appending leftovers, mirroring `model.mjs`
`buildConstellation` defensive handling.
