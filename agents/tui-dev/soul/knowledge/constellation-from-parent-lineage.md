---
type: Concept
title: Constellation tree from parentInstance lineage with defensive cycle handling
description: buildConstellation nests instances by forward-only parentInstance metadata, treats unknown or missing parents as roots, sorts running-first, and includes a second pass so cyclic or malformed metadata can never hide a live instance.
tags: [control-pane, constellation, lineage, model]
timestamp: 2026-07-20
---

The pane's primary shape is the spawn constellation. `buildConstellation`
(model.mjs) turns the flat instance list into ordered rows:

- Parent link is `instance.parentInstance` — forward-only metadata recorded at
  spawn time from the caller's OAS instance environment. A child whose parent
  is not in the current list (retired) becomes a flat root; legacy instances
  with no `spawnOrigin` show as "unlinked" in the header count. History is
  never reconstructed — this is a deliberate decision (see the reference
  concept to the standalone-TUI decision).
- Sort order at every level: running before idle, then `createdAt`, then name.
- Each row carries `{ instance, depth, ancestorsLast, last }`; `ancestorsLast`
  is the list of "was my ancestor the last child?" booleans the renderer uses
  to draw `│` continuation vs blank trunk segments.

**Gotcha learned the hard way**: a DFS from roots alone can drop instances if
metadata is malformed (e.g. `a.parentInstance === "b"` and vice versa — no
root exists in the cycle). The function ends with a defensive second pass:

```js
for (const instance of instances) if (!visited.has(instance.instance)) visit(instance, 0, [], true);
```

Malformed metadata must degrade to a flat root, never to an invisible live
agent. There is a regression test for exactly this
(`test/control-pane-model.test.mjs`, "buildConstellation cannot lose cyclic
malformed metadata") — keep it passing.
