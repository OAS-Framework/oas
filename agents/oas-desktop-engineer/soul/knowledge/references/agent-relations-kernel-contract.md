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
`--relative-root <agents-root>` qualifies a same-named team anchor; the desktop
picker sends the selected instance's name and agents root together.
`relation=parent` re-points the anchor under the new instance, so the new instance takes the anchor's old tree slot.
Attached mode always produces child-of-owner; non-child relation flags are rejected, and a non-instance integration work tree requires explicit `--parent <owner>`.
`oas spawn --json` adds `sibling` and `relation` next to `parent`.

# Errors

Final error behavior:

- `E_RELATIVE_NOT_FOUND`: bad anchor.
- `E_RELATIVE_AMBIGUOUS`: the anchor name/root pair cannot produce an unambiguous, round-tripping lineage edge (including inherited-edge ambiguity).
- `E_BAD_ARGS`: invalid flag matrix. In particular, `--relative-to` without
  `--relation` is rejected, never ignored; `unrelated` takes no anchor; and
  `--relative-root` only qualifies `--relative-to`/`--parent`.

# Desktop integration points

Desktop threads these fields through both shipped integration points:

- `instanceLinks()` in `packages/desktop/renderer/instance-tree.mjs` consumes
  `parentInstance` plus `siblingInstance` for connected-component clustering.
- The `/api/panel` projection in `packages/desktop/server/oas-web.mjs`
  explicitly allowlists `siblingInstance`, `relation`, and `relativeTo` from
  roster metadata; `packages/desktop/server/model.mjs` spreads the underlying
  instance metadata transparently.
