---
type: Concept
title: Spawn relations map to sparse lineage fields
description: oas spawn relations use parentInstance for ordinary child and non-root sibling cases, siblingInstance only for root-sibling edges, parent relation re-points the anchor through a slot-inheriting new parent, and retireInstance splices links that point at a retiree.
tags: [spawn, lineage, relations, kernel, cli]
timestamp: 2026-07-25
---

# Shape

`oas spawn --relation child|sibling|parent|unrelated --relative-to <instance>`
records only the lineage fields that consumers need. `--parent <instance>` is
sugar for the child relation.

- **Child** records the anchor as `parentInstance` on the new instance.
- **Sibling** does not add a new tree shape when the anchor already has a
  parent: the new instance shares the anchor's `parentInstance`. When the
  anchor is a root, the new instance records `siblingInstance: <anchor>` so the
  root-level cluster stays connected without mutating the anchor. Hierarchy
  consumers treat connected components over `parentInstance` and
  `siblingInstance` edges as sibling clusters.
- **Parent** is the only relation that mutates another instance's metadata: the
  anchor's `instance.json` is re-pointed to `parentInstance = <new instance>`.
  The new parent inherits the anchor's old `parentInstance` and `siblingInstance`
  so it takes the anchor's previous slot in the tree. Delete the anchor's old
  `siblingInstance`; the new parent carries that cluster edge and duplicate
  edges confuse traversal.
- **Unrelated** is normalized away before recording. Absent lineage fields mean
  unrelated; consumers should never see `relation: "unrelated"` as stored
  metadata. During option parsing, however, an explicit unrelated request must
  survive as an `explicitUnrelated`-style fact until defaults and fallbacks have
  run, so attached-mode auto-parenting does not treat explicit negation as an
  omitted relation.

# Retirement repair

Relations that write cross-instance links must specify what happens when either
side retires. `retireInstance` splices a retiree out of the graph: instances
whose `parentInstance` or `siblingInstance` names the retiree inherit the
retiree's own links; if the retiree had no links they become roots, and dangling
sibling links are dropped. The result includes `relinked[]` so callers can
report which instances were repaired.

This repair is required for parent relation: an ephemeral parent retiring should
hand anchored instances back to the displaced parent instead of leaving
`parentInstance` pointing at a missing instance. See the broader
[relation-policy lesson](/lessons/relation-policy-migration-and-retire-splice.md).

# Validation boundary

Relation validation intentionally happens in both surfaces: the CLI returns
stable pre-scaffold errors such as `E_BAD_ARGS` or `E_RELATIVE_NOT_FOUND`, while
the kernel still throws for programmatic callers. Sibling and parent relations
must read the anchor's `instance.json` in the kernel; fail before scaffolding and
before lifecycle hooks if it is missing or unreadable. Re-read in the kernel even
when the CLI already checked, because anchor state can change between the CLI
check and the kernel read.

This extends the explicit-lineage rule in
[spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md): the
caller chooses the relation, but the recorded metadata stays sparse and local to
the affected instances. The no-side-effects validation lesson is captured in
[kernel-validation-before-side-effects](/lessons/kernel-validation-before-side-effects.md).
