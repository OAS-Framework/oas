---
type: Reference
title: Final kernel contract for spawn-time agent relations
description: oas status --json and the desktop collect payload expose parentInstance, siblingInstance, relation, and relativeTo for spawn-time agent relations, and desktop clusters are connected components over parent and root-sibling edges.
tags: [desktop, agent-relations, kernel-contract]
timestamp: 2026-07-25
---

Relayed as FINAL by dev-coordinator-parallel for feature/agent-relations; cli-dev owns the kernel side. The desktop grouping decision consumes this contract through the seam described in [Desktop cluster grouping consumes the final siblingInstance seam](/decisions/desktop-cluster-grouping-sibling-seam.md).

# Status payload

Per-instance fields in both `oas status --json` and the desktop collect payload:

- `parentInstance`: unchanged.
- `siblingInstance`: string, only set when a sibling relation was declared against a root instance. A sibling of a non-root just shares the anchor's parent, with no extra field.
- `relation`: `"child"`, `"sibling"`, or `"parent"`; absent means unrelated.
- `relativeTo`: the anchor named at spawn.

# Clustering

Desktop clusters are connected components over both edge kinds: `parentInstance` and `siblingInstance`.

# Spawn CLI

Spawn accepts `--relation child|sibling|parent|unrelated --relative-to <instance>`.
`--parent X` is sugar for `--relative-to X --relation child`.
`relation=parent` re-points the anchor under the new instance, so the new instance takes the anchor's old tree slot.
`oas spawn --json` adds `sibling` and `relation` next to `parent`.

# Errors and pending clarifier

Known error codes:

- `E_RELATIVE_NOT_FOUND`: bad anchor.
- `E_BAD_ARGS`: invalid flag matrix.

Pending clarifier from the relay: whether `--relative-to` without `--relation` rejects or ignores. Desktop rejects it; the stricter behavior is safe.

# Desktop integration points

Desktop must thread these fields through both:

- `instanceLinks()` in `packages/desktop/renderer/instance-tree.mjs`.
- The `/api/panel` projection in `packages/desktop/server/oas-web.mjs`, which has an explicit allowlist. Kernel fields do not flow through automatically there, though `packages/desktop/server/model.mjs` spreads metadata transparently.
