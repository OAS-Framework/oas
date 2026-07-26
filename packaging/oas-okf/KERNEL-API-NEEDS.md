# Historical OKF runtime-boundary inventory

The original extraction inventory identified four private-kernel needs in `oas okf harvest`: agent lookup, local service-agent registration, effective setting resolution, and instance spawning in three source modes.

Corrected package-engine head `19fbc86` satisfies the inventory through the final structured CLI boundary. Capability command dispatch supplies the canonical absolute CLI path as `OAS_CLI_BIN`; harvest invokes that path with `execFile` and never searches `PATH`:

- `memory-harvest` is a capability-defined agent under `agents/memory-harvest/`, replacing private lookup/upsert calls;
- `oas spawn memory-harvest ... --json` replaces private `spawnInstance` use for attached local-soul, worktree workspace-soul, and attached repo-resident modes;
- effective `harvest-model` arrives through command dispatch in `OAS_SETTINGS`, replacing private config resolution; and
- task text crosses the process boundary through owner-only mode-0600 temporary files that are removed on every outcome.

The final package no longer discovers the kernel root, calls `oas root`, searches `PATH`, or imports `lib/core.mjs`. Binary selection is isolated in `packageRuntimeCli()`, which requires the dispatcher's canonical absolute `OAS_CLI_BIN`; execution uses argv-safe `execFile`. Compatibility floor `>=0.19.0` plus the released consumer fixture versions this boundary.
