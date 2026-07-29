---
type: Lesson
title: V1 lock migration is all-or-nothing per scope — no residue container in revised v2
description: When documenting OAS package migration, state that a scope converts to revised v2 only if every entry maps; any unmappable entry holds the whole scope on byte-identical v1, and a converted lock never carries leftover v1 residue.
tags: [oas, packages, migration, lockfile, docs, capability-materialization]
timestamp: 2026-07-29
---

# V1 lock migration is all-or-nothing per scope

The founder ruling (confirmed in `lib/core.mjs`, `migrateLegacyLock` / `applyMigration`): **there is no residue container in revised `lockfileVersion: 2`.** V1 lock migration is all-or-nothing per scope.

- A scope converts to revised v2 only when every entry it must convert maps to a package. If any required entry is unmappable (a marketplace id the catalog does not resolve, or an unknown source), the whole scope stays byte-identical v1 and keeps working. Re-run later.
- A successful run writes a fresh v2 lock (`{ lockfileVersion: 2, packages: {}, capabilities: {} }` populated with the converted capabilities). It never carries leftover v1 entries. `migrateLegacyLock` returns `residue: []` on success; the internal `residue` field is only populated with capability ids when a scope is skipped, not converted-with-residue.
- Guided `oas migrate --official` converts only official (marketplace) capabilities and leaves `git:`/`path:`/unknown sources byte-identical (`action: retain`). An official capability with no catalog mapping is `action: hold` and holds the whole scope.
- Plain `oas migrate` converts custom sources too, and is all-or-nothing (`action: manual` for an unmappable source means the scope is held).

## Why this was a doc trap

The pre-change public docs said migration "retains unmappable entries as legacy residue in the v2 lock." That was the old transitional model. Preserving that prose while reterming everything else is easy to miss; the current model has no residue.

## Do not document `migrationResidue[]` as contract

`oas doctor` still emits a `migrationResidue[]` array, but the engine owner ruled it "not final contract." Document the real diagnostics instead:

- a legacy v1 lock pending migration, with `oas migrate --dir <scope>` retry and `officialMigration` readiness; and
- an unsupported transitional-v2 lock, which must be fixed or removed rather than auto-repaired.

## Related trust fact

Acquisition never grants executable trust. Only kernel-shipped bundled capabilities and `owned/` source are trusted without `oas trust`; official catalog packages that are git-sourced need explicit `oas trust`. Drop any "trusted at acquisition" or "framework-trusted because they ship with the kernel" phrasing from install/onboarding docs.

See also [Capability-materialization doc terminology and the depsIntegrity trap](capability-materialization-doc-terminology.md) for adjacent package/config terminology and trust invariants.
