---
type: Lesson
title: Final package lifecycle transaction invariants
description: No-op acquisition must bind installed runtime bytes to the prior deps lock, removal must use the target's own scope map and roll back artifact moves, and update must preserve the original catalog selector form.
tags: [packages, transactions, integrity, locks, updates]
timestamp: 2026-07-26
---

# Package lifecycle invariants

These final package lifecycle invariants extend the [package engine gotchas](/lessons/package-engine-implementation-gotchas.md) and the [depsIntegrity trust-binding lesson](/lessons/deps-integrity-trust-binding.md):

1. A source-integrity-only keep can bless tampered `node_modules` by hashing the observed tree into a new lock. A true keep requires both installed source and runtime digests to match the prior lock. Mismatch is repaired from a staged, materialized, containment/native-checked source; plain acquire may never advance the prior runtime digest.
2. Closest-wins merged lock maps are for lookup, not mutation authorization. Removal dependents must be checked in the target entry's complete own-scope map. Move the artifact to a backup, write the lock, and restore both lock bytes and artifact on failure.
3. Catalog update must reconstruct the original source spec. Lock bare catalog input as `catalog:<id>` and explicit selectors as `catalog:<id>@<selector>`; keep the resolved commit in the separate `commit` field. Update passes an explicit selector through and re-resolves defaults only for originally-bare specs.
