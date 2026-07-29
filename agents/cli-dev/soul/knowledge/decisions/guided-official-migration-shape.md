---
type: Decision
title: Guided official migration uses catalog aliases and per-scope holds
description: Guided official migration (`oas migrate --official [--recursive]`) maps legacy marketplace capabilities through catalog aliases, holds a scope unchanged when an official mapping is missing, and retains non-official entries without rewriting.
tags: [packages, migration, catalog, oas-lock, cli]
timestamp: 2026-07-28
---

# Decision

The existing-user 0.18→0.19 upgrade path is a guided command over the existing
legacy-lock migration engine: `oas migrate --official [--recursive] [--dry-run]
[--dir <d>] [--json]`. Guided mode is selected by `--official` or
`--recursive`; with neither flag, the command keeps the previous single-scope
migration path.

# Guided engine semantics

When `official: true` reaches the migration engine, it changes three legacy
marketplace behaviors:

1. **Legacy `marketplace:` entries resolve through the catalog capability alias
   map.** The catalog owns legacy-capability → package mapping through a
   `capabilities` object, and the acquired spec is the bare package id. Guided
   migration does not derive a `v<v1.version>` selector from the legacy
   capability entry, because that version belongs to the capability, not to the
   package's tag namespace.
2. **Missing official mappings hold the scope unchanged.** A missing mapping
   raises `official-mapping-unavailable` before any write. Generic migration may
   convert the file to v2 and keep the entry as residue, but guided official
   migration must leave that scope's v1 lock byte-for-byte usable until the
   official package mapping exists.
3. **Non-official entries are retained.** Git, path, unknown, and retired
   entries are not acquired by guided official migration. A scope with no
   official work returns `skipped` and does not reformat its v1 file.

   Implementation warning: a mixed scope with at least one official `acquire`
   and at least one non-official `retain` cannot simply be rewritten to
   revised-v2 while omitting the retained v1 rows. The revised-v2 shape has no
   v1 residue container, so the engine must either hold the whole mixed scope or
   add an explicit residue strategy. See [mixed guided migration retain needs
   residue or a hold](/lessons/guided-mixed-retain-needs-residue-or-hold.md).

# Catalog shape

The catalog is data, not code:

```json
{
  "packages": { "oas.dev": { "url": "...", "path": "oas-package" } },
  "capabilities": { "oas.review": "oas.dev" }
}
```

`capabilities` is the legacy-capability → package alias map. Identity mappings
such as `oas.okf` → `oas.okf` need no entry. Both catalog maps are untrusted
input: parse them into null-prototype objects and read with `Object.hasOwn`, as
in the [prototype-safe policy map lesson](/lessons/prototype-safe-policy-map-lookups.md).
Catalog package roots still follow the [package payload root
contract](/decisions/package-payload-root-contract.md): the catalog owns its
`path` field.

# Aggregate honesty

Each scope keeps the engine's own transaction boundary. Recursive CLI mode plans
every scope first in deterministic path order, ancestors first, then applies
scopes one by one. A failing scope rolls back byte-identically, other scopes keep
their successful results, and the run exits nonzero with `E_MIGRATE_FAILED` plus
the complete per-scope report under `error.details`.

The JSON failure envelope remains the same shape used by package reconciliation:
`{schemaVersion, ok, error}`. Preserve the command-wide envelope discipline from
[json-mode CLI contracts](/lessons/json-mode-cli-contract.md) and the
[dispatcher boundary lesson](/lessons/json-envelope-dispatch-boundary.md).

# Manual smoke gotcha

Do not manually smoke this command in the repository work tree. See
[never run migrate in the work tree](/lessons/never-run-migrate-in-the-work-tree.md).
