---
type: Lesson
title: Capability-materialization doc terminology and the depsIntegrity trap
description: When documenting OAS packages after the capability-materialization/config-template change, use config template / adopted base and verify runtime-closure integrity lives on the capability artifact, not a separate depsIntegrity field.
tags: [oas, packages, capabilities, config-templates, docs, terminology]
timestamp: 2026-07-29
---

# Capability-materialization doc terminology and the depsIntegrity trap

The founder-accepted capability-materialization/config-template model replaced
several older public doc terms. When auditing or writing OAS package/config
docs, apply this mapping and verify against `lib/core.mjs`, `lib/packages.mjs`,
`docs/oas-lock.schema.json`, and `docs/oas-package.schema.json`.

## Terminology mapping (old -> current)

- "config profile" / "profile" -> **config template**.
- "snapshot" (of adopted config) -> **adopted base** (recorded under
  `.agents/config-templates/adopted/<package>/<template>/` with `adoption.json`).
  Reserve "snapshot" only for unrelated filesystem-rollback backups.
- `.agents/packages/installed/<package>/` (persistent package store) -> gone.
  Packages are transient transport. Each capability **materializes** into
  `.agents/capabilities/installed/<id>/`, the only installed entity.
- Lock: `lockfileVersion: 2` has TWO top-level maps — `packages` (source,
  commit, path, payload integrity, dependencies) and `capabilities` (version,
  package, path, artifact integrity, trusted). No v3.

## The depsIntegrity trap

Old docs claimed a capability's materialized `node_modules` is hashed
separately as a lock `depsIntegrity` field. That is FALSE in the current model.
`depsIntegrity` on a package row is one of the `TRANSITIONAL_ROW_FIELDS`
(`lib/core.mjs`) that mark the unsupported transitional-v2 shape. The runtime
closure is part of the capability's own artifact integrity — the package
payload hash EXCLUDES `node_modules` (core skips `node_modules` when hashing
the payload), so tampering with materialized deps resets that capability's
trust like source drift. `npm ci` flags are
`--omit=dev --omit=peer --ignore-scripts --no-audit --no-fund`.

## Trust and adoption invariants

- Trust binds to the exact capability artifact integrity; official
  catalog/package identity grants NO executable trust. Only kernel-bundled
  legacy capabilities are framework-trusted, and that must be labeled legacy.
- `oas install <pkg>` materializes capabilities but adopts NO template.
  `oas init --package <src> [--config <t>]` adopts exactly one.
- Config commands: `oas config diff | sync [--accept <regionId>=local|package] |
  sync --reset --yes | adopt <pkg> [--config <t>]`.

## Gotcha: CLI static help lagged the runtime

At integrated head `d74edbb`, runtime messages used the new terms but
`oas --help` static text still said "profile/snapshot" for `config diff`/`init`
and omitted `config sync`/`config adopt`. Treat stale `--help` as a CLI defect,
not doc truth; verify command behavior from the code, not the help string.
