# Historical OKF runtime-boundary inventory

The original extraction inventory identified four private-kernel needs in `oas okf harvest`: agent lookup, local service-agent registration, effective setting resolution, and instance spawning in three source modes.

Those needs are now met by the frozen structured CLI boundary in `docs/design/package-runtime-api.md` at package-engine addendum head `dfa2ae7`:

- `memory-harvest` is a capability-defined agent under `agents/memory-harvest/`, replacing private lookup/upsert calls;
- `oas spawn memory-harvest ... --json` replaces private `spawnInstance` use for attached local-soul, worktree workspace-soul, and attached repo-resident modes;
- effective `harvest-model` arrives through command dispatch in `OAS_SETTINGS`, replacing private config resolution; and
- task text crosses the process boundary through owner-only mode-0600 temporary files that are removed on every outcome.

The package no longer discovers the kernel root, calls `oas root`, or imports `lib/core.mjs`. Compatibility floor `>=0.19.0` and the pinned consumer fixture version this boundary.
