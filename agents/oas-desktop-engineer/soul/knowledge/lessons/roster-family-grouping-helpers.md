---
type: Lesson
title: Keep roster family grouping helpers inside instance-tree
description: Roster family grouping and sort helpers belong in renderer/instance-tree.mjs so common.mjs groupInstances keeps the shape consumed by the shell context roster.
tags: [desktop, renderer, roster, grouping, compatibility]
timestamp: 2026-07-25
---

# Keep roster family grouping helpers inside instance-tree

When adding repo → agent-family grouping with sort modes to the Instances roster,
do not change `common.mjs`'s `groupInstances` shape. `shell.mjs`'s context
roster consumes that helper, so changing it can break the shell-owned roster
surface while the Instances view is mid-feature.

Keep pure roster-tree grouping logic in `renderer/instance-tree.mjs`, the module
that already owns tree helpers and tests. The repo/family grouping work added
`groupRosterFamilies`, `rosterRank`, `rosterGroupKey`, and `ROSTER_SORTS` there
instead of overloading `common.mjs`.

Design details to preserve:

- Group collapse keys are workspace-scoped: `rosterGroupKey(ws, repo[, fam])`,
  mirroring the existing per-instance collapse-key discipline.
- Filtering force-expands groups with disabled header buttons, so a click cannot
  invisibly mutate persisted collapse state while the filter owns expansion.
- Cross-family or cross-repo `parentInstance` links are cut; the child renders
  as a root of its own family group. The lineage walk is cycle-safe through a
  `seen` set.
- Unknown persisted sort IDs fall back to `status`, so stale `localStorage`
  cannot break rendering.
- Grouping and sorting keys that come from workspace-controlled metadata must be
  string-coerced before `localeCompare`; see [String-coerce workspace metadata before roster grouping and sorting](/lessons/roster-grouping-string-coerce-metadata.md).

Related architecture: [Desktop renderer views port of the panel](/architecture/desktop-renderer-views-port.md).
