---
type: Decision
title: Package-runtime boundary is the structured CLI API
description: Official packages reach the kernel only through oas CLI commands with Desktop-API-v1 JSON envelopes and a packageRuntimeApi probe field; a blessed module export was rejected because it preserves the oas-root dynamic-import coupling and creates a second public JS surface.
tags: [packages, runtime-api, cli, trust]
timestamp: 2026-07-26
---

# Package-runtime boundary = structured CLI

Official packages must not import `lib/core.mjs`, even through `oas root` and a dynamic import. The selected package-runtime boundary is the `oas` CLI command surface with the existing Desktop-API-v1 JSON envelope discipline, versioned by a `packageRuntimeApi` probe field in `oas version --json`; the floor kernel is 0.19.0.

Surface v1, driven by the real `oas.okf` consumer inventory:

- `oas agent show/upsert`
- `oas spawn --instance/--ephemeral`, plus existing spawn flags
- `oas config get <dotted.path>`

The rejected module-export option keeps the dynamic-import coupling, creates a second public JavaScript API surface that must stay in lockstep forever, and weakens semver testability.

The contract lives in `docs/design/package-runtime-api.md`.

# Implementation notes

- `spawnInstance` already accepted `o.instance`; only CLI plumbing was needed.
- `--ephemeral` maps to the `kind: "capability"` override `oas.okf` applied by hand.
- The consumer fixture in `test/packages.test.mjs` mirrors the okf call pattern end-to-end through `spawnSync` of the CLI.
