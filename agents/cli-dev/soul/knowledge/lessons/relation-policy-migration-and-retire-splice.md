---
type: Lesson
title: Relation policy changes must migrate recipes and specify retirement repair
description: Introducing or changing spawn relation policy must update every agent-facing spawn recipe and define how retireInstance repairs any lineage metadata it mutates.
tags: [spawn, relations, lineage, retire, injections, migration]
timestamp: 2026-07-25
---

# Lesson

A spawn-relation policy change is unsafe if code and agent-facing recipes move
apart. When the "reviewers are your parent" policy became binding, stale
`oas-review` injection examples still showed relation-less attached reviewer
spawns, which auto-nested the reviewer under the developer, and maintainer
spawns with `--parent "$OAS_INSTANCE"`, which made maintainers children.

Future changes to spawn semantics or relation policy must migrate every live
recipe in the same change. Grep for `oas spawn` across injections, soul skills,
and docs, not only kernel docs. This extends the migration rule in
[spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md).

# Retirement invariant

A relation that mutates another instance's lineage also needs retirement repair.
The parent relation re-points the anchor's `parentInstance` at the new instance;
without retire repair, an ephemeral reviewer retiring would leave the anchor
pointing at a missing instance and silently remove it from its displaced
coordinator's children.

`retireInstance` must splice a retiree out of the graph: any instance whose
`parentInstance` or `siblingInstance` names the retiree inherits the retiree's
own links; link-less retirees leave roots; dangling sibling links drop. The
result exposes `relinked[]` so callers can report the repaired instances. The
current lineage shape is summarized in
[spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md).

# Related

If the recipe migration edits `capabilities/<pkg>/` sources, also apply the
[capability source lock-refresh lesson](/lessons/capability-source-edits-require-lock-refresh.md): bump the package version and refresh the matching lock entry in the same commit.
