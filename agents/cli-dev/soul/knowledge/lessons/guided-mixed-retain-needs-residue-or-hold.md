---
type: Lesson
title: Mixed guided migration retain needs residue or a hold
description: A guided official migration scope that both acquires official packages and retains custom v1 entries cannot be rewritten to revised-v2; the accepted fix is to refuse the whole mixed scope unchanged rather than add a residue container.
tags: [packages, migration, oas-lock, residue, capability-materialization]
timestamp: 2026-07-29
---

# Failure mode

A 0.18 scope can hold official legacy entries such as `oas.okf` and
`oas.review` alongside custom or vendored `git:` and `path:` capabilities. In
that mixed shape, guided migration planned the custom entries as `retain`,
reported them as "kept unchanged", and finished with `status: "migrated"` and
`residue: []`.

The written revised-v2 lock contained only package/capability rows for the
official work. The custom rows were gone even though their artifacts remained on
disk, so the next resolution failed with a missing-lock error such as:

```text
external capability "custom.cap" is not usable: not locked in oas-lock.json
```

All-official fixtures and `--official` scopes with no official work do not cover
this. The former has nothing to retain; the latter returns `skipped` early and
never rewrites the lock.

# Why `retain` is not just another plan row

The manual migration branch already refuses a conversion when there is no
residue container for entries it cannot map: converting the mappable rows while
silently dropping the rest would leave the deployment worse than before.
`retain` in a mixed guided scope has the same shape.

A revised-v2 lock has `{packages, capabilities}` and no place for a v1
`marketplace:`, `git:`, or `path:` capability row that is not acquired into a
package. Any scope with at least one `acquire` and at least one `retain` needs an
explicit product choice before the file is rewritten.

# Resolution

The product choice is now made: [mixed scope migration refuses whole](/decisions/mixed-scope-migration-refuses-whole.md).
Do not add an explicit residue container. A mixed official-plus-custom guided
scope must be held/refused before any mutation, with the whole v1 scope left
byte-identical and usable.

# Future rule

Do not claim a custom entry was retained unless the resulting lock can still
resolve it. For guided official migration, the safe choice is the fail-closed
one: hold the whole mixed scope unchanged, matching the manual branch's
behavior, and report the blocked state so dry-run cannot look ready.

Regression coverage for guided official migration must include a mixed
official-plus-custom scope and assert the post-migration lock, not only the plan
report. This sharpens the [guided official migration shape](/decisions/guided-official-migration-shape.md)
and the existing [batched residue migration lesson](/lessons/residue-collision-during-batched-migration.md).
