---
type: Decision
title: Guided official migration uses catalog aliases and mixed-scope refusals
description: Guided official migration maps legacy marketplace capabilities through catalog aliases, holds scopes unchanged when official mappings are missing, skips non-official-only scopes, and refuses mixed acquire-plus-retain scopes before mutation.
tags: [packages, migration, catalog, oas-lock, cli]
timestamp: 2026-07-29
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
3. **Non-official-only scopes are skipped; mixed acquire-plus-retain scopes
   refuse.** Git, path, unknown, and retired entries are not acquired by guided
   official migration. A scope with no official work returns `skipped` and does
   not reformat its v1 file; its untouched ids are reported under `retained`.

   A mixed scope with at least one official `acquire` and at least one
   non-official `retain` is `blocked`/refused before lock, artifact, or ignore
   mutation. `retain` clears `convertible` the same way `hold` and `manual` do
   so dry-run and apply agree that the scope is not convertible. The refusal
   message names every retained entry, states the whole v1 scope remains usable,
   and, when every retained source is package-mappable, names plain
   `oas migrate` as the complete conversion path. Do not add a revised-v2
   `residue` container. See [mixed scope migration refuses whole](/decisions/mixed-scope-migration-refuses-whole.md)
   and the original [residue-or-hold failure lesson](/lessons/guided-mixed-retain-needs-residue-or-hold.md).

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
