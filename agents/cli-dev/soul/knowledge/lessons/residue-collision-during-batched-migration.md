---
type: Lesson
title: Batch residue removal before acquiring packages during migration
description: When multiple legacy capabilities convert to one package, deleting only the current residue before acquiring collides with sibling entries the package also exports.
tags: [packages, migration, oas-lock, residue, transactions]
timestamp: 2026-07-28
---

# Defect

`applyLegacyLockMigration` looped per plan step: delete the current
capability's v1 residue entry, then `acquirePackage(spec)`. Acquisition refuses
a package that exports a capability id still present in the lock's residue map
with `duplicate-capability-id`.

With two legacy capabilities aliased onto one package — the shape
`oas.review` → `oas.dev` invites — the first acquire saw the second capability
still in residue and failed. The scope rolled back correctly, so the symptom was
"this deployment cannot migrate at all", not corruption.

Single-capability fixtures could not catch it; the collision needs a second
entry supplied by the same package.

# Rule

When a transaction converts multiple entries out of a shared map, and the callee
validates against that map, remove everything the transaction will convert
before the first call, not one entry per iteration. Group the work by the unit
the callee operates on — here, the source spec, so each package is acquired once
— then validate per member afterwards.

The whole-file rollback made the wider pre-delete safe: the original lock is
restored wholesale on any failure, so removing all converted entries up front
does not weaken the transaction.

# Generalization

Any "delete my row, then ask the engine to accept me" loop is suspect when the
engine's acceptance check reads the whole collection. The narrower the
pre-delete, the more likely a sibling row denies the operation.

This failure is in the [guided official migration](/decisions/guided-official-migration-shape.md)
area and sharpens the earlier corrected-head note about migration residue fixes
in the [package-engine re-merge map](/references/package-engine-corrected-head-remerge-map.md).
