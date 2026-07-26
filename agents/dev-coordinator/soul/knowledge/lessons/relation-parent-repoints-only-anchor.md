---
type: Lesson
title: "`--relation parent` re-points only the anchor's lineage"
description: When spawning an overseer for multiple instances, the relation flag binds only the spawning instance; the other party must be brought under the new parent separately.
tags: [oas, spawn, relations, coordination]
---

# `--relation parent` re-points only the anchor's lineage

`oas spawn X --relation parent --relative-to "$OAS_INSTANCE"` re-points the
CALLING instance's recorded lineage so X becomes its parent (verified in
`lib/core.mjs` — "parent relation: re-point the ANCHOR's recorded lineage").
There is no flag that makes one spawn the parent of two existing instances at
once, and no standalone re-parent command surfaced in the CLI help.

So when two peer coordinators need a shared oas-expert arbiter as parent of
both: one coordinator spawns it with `--relation parent`, and the other must
be brought under it separately — by agreement between the coordinators or by
the expert instructing the peer. Soul guidance written for this (2026-07-26)
tells the spawner to state in the task brief that the expert oversees both
and that its ruling binds both.
