# Package-runtime API contract (addendum to the package-engine contract)

Status: **FROZEN** once merged to `feature/package-engine`, as an addendum to
[`package-engine-contract.md`](./package-engine-contract.md). It answers the
maintainer's four clarifications on the M1 freeze (maintainer review of
1db919b): the public package-runtime boundary, the npm runtime closure,
incremental transaction semantics, and runtime-validated schema invariants.
Changes go through the coordinator to the maintainer.

## 1. Public package-runtime boundary (structured CLI API)

**Transport choice: the structured CLI API.** Rationale (tradeoff surfaced to
the coordinator/maintainer before freezing, mail 09447984): a process contract
is a true version boundary — it survives kernel-internal refactors and node/ESM
changes, nothing private is importable by construction, and it extends the
already-proven Desktop CLI API v1 envelope discipline instead of creating a
second public JS surface that must be kept in semver lockstep with the CLI
forever. The rejected alternative (a blessed `lib/runtime.mjs` import resolved
via `oas root`) preserves exactly the dynamic-import coupling the maintainer
ruled out.

**Rule: independently released packages MUST NOT import kernel-private
`lib/core.mjs` (including via `oas root` + dynamic import).** Package
commands/hooks invoke the `oas` binary already on PATH in their execution
environment.

### Envelope and versioning

Every boundary command supports `--json` with the Desktop CLI API v1 envelope:
exactly one JSON object on stdout — `{ schemaVersion: 1, ok: true, result }`
or `{ schemaVersion: 1, ok: false, error: { code, message } }` — nonzero exit
on failure; progress prose only on stderr.

- **Probe**: `oas version --json` →
  `{ schemaVersion: 1, name, version, desktopApi: 1, packageRuntimeApi: 1 }`.
  `packageRuntimeApi` is the boundary's contract version; it increments only
  on breaking changes to the commands/results below.
- **Floor**: the boundary (and lock v2) ships in kernel **0.19.0**. Official
  packages consuming it declare `compatibility.oas: ">=0.19.0"` in
  `oas-package.json` (and capability `compatibility.oas` likewise). Consumer
  CI pins its probe to `packageRuntimeApi === 1`.

### Commands (exact surface, packageRuntimeApi 1)

Covers the complete official-package consumer inventory (oas.okf:
`findAgent`, `upsertLocalAgent`/`upsertTmpAgent`, `spawnInstance`,
`resolveOasConfig`; no other official package imports core).

1. **Agent lookup** — `oas agent show <name> [--dir <d>] --json`
   - result: `{ name, kind, repo, work, runtime, model, type, dir } | null`
     (null result with `ok: true` when the agent does not exist; lookup is not
     an error).
2. **Local agent upsert** — `oas agent upsert <name> --instructions-file <f>
   [--description <text>] [--dir <d>] --json`
   - registers/updates a LOCAL soul (uncommitted, `local-agents/`), exactly
     `upsertLocalAgent`; result: `{ name, dir, created }`.
3. **Spawn** — `oas spawn <agent> ... --json` (existing command; the boundary
   adds/fixes the options the consumer inventory needs):
   - `--instance <name>` exact instance name (used instead of `--purpose`
     naming; collision → `E_SPAWN_FAILED`),
   - `--ephemeral` treat the agent as service infrastructure regardless of
     its on-disk kind (the `kind: "capability"` override oas.okf applies),
   - existing `--parent`, `--repo`, `--work attached|worktree|...`,
     `--work-dir`, `--branch`, `--model`, `--task`/`--task-file` carry over
     unchanged with their existing validation and error codes
     (`E_BAD_ARGS`, `E_PARENT_NOT_FOUND`, `E_SPAWN_FAILED`, ...);
   - result: the fixed Desktop CLI API v1 spawn shape
     (`{ instance, agent, home, work, ... }`).
4. **Resolved-config read** — `oas config get <dotted.path> [--soul <name>]
   [--dir <d>] --json`
   - reads ONE value from the resolved configuration (the
     `resolveOasConfig` projection), e.g.
     `oas config get layers.knowledge.settings.harvest-model`;
   - result: `{ path, value }` (`value: null` when unset; unknown top-level
     roots → `E_BAD_ARGS`). Read-only; never an editing surface.
5. **Probe** — `oas version --json` (above).

Error codes are part of the contract: `E_USAGE`, `E_BAD_ARGS`,
`E_UNKNOWN_COMMAND`, `E_SPAWN_FAILED`, `E_PARENT_NOT_FOUND`,
`E_RELATIVE_NOT_FOUND`, `E_RELATIVE_AMBIGUOUS`, `E_CAPABILITY_BLOCKED`.

### Consumer fixture

The engine ships a consumer fixture test that drives the full oas.okf call
pattern exclusively through this CLI surface (agent show → upsert → config
get → spawn attached, `--json` envelopes asserted), so a boundary regression
fails the kernel's own CI before it can break a published package. WS3 reuses
the same fixture shape as each official repo's per-repo CI probe, combined
with the acquire → lock → trust → activate → spawn probe from
`test/packages.test.mjs`.

## 2. Package-local npm runtime closure

- **Detection and placement**: materialization roots are (a) the PACKAGE root
  and (b) each manifest-declared capability directory — any of these carrying
  BOTH `package.json` AND `package-lock.json` is materialized independently.
  Per-capability locks are the norm when an inner `oas.json` resolves
  resources via `node_modules/...` relative to the capability manifest (e.g.
  oas-aweb's `node_modules/@awebai/pi/skills/...`): deps land beside the
  manifest that references them, inside the package containment boundary. A
  package-root lock serves package-wide tooling. One or many locks per
  package are allowed; each is its own `npm ci` unit. Directories not
  enumerated by the manifest are never scanned.
- **When**: materialization runs at the END of a successful acquire, update,
  and restore of that package (after integrity verification, before the
  operation reports success). It is `npm ci --ignore-scripts --no-audit
  --no-fund` in the package root — **no npm lifecycle scripts ever run**, at
  any phase.
- **Integrity coverage**: the lock `integrity` covers the package SOURCE tree
  only — every `node_modules` (at any depth) is excluded from the hash (as
  are `.git` and `oas-lock.json`). The dependency closures' integrity is
  carried by the checked-in `package-lock.json` files, which ARE inside the
  hashed source tree; `npm ci` fails closed on any lockfile mismatch. Doctor
  reports source integrity + the presence/staleness of materialized closures.
- **Reproducibility**: `node_modules` is a derived, platform-dependent
  artifact — never hashed, never committed, always reproducible from the
  locked `package-lock.json` on the host platform. A failed materialization
  is a WARNING on acquire/update reports (the source artifact and lock are
  still valid and exact); doctor surfaces it until resolved.
- **Containment**: capability code/hook paths must resolve inside the locked
  package root after symlink resolution; materialized `node_modules` trees
  under that root (package-root or per-capability) are inside the boundary by
  construction. Paths escaping the root — including through `node_modules`
  symlinks — are `path-escape`.
- **Rollback**: materialization happens after the artifact/lock commit point;
  a materialization failure never rolls back or invalidates the acquired
  package (re-running install/update retries it). A failure BEFORE the commit
  point rolls back per §3 with no `node_modules` remnants (staging directories
  are removed wholesale).

## 3. Incremental transaction semantics

Acquire/update of one package closure is **incremental with respect to the
scope**, never a wholesale store replacement:

- Installed packages, lock entries, and `trustedCapabilities` of packages NOT
  in the resolved closure are untouched — bytes on disk and lock JSON both.
- Within the closure, a package whose new integrity EQUALS its currently
  locked integrity is kept in place ("kept" in reports) and its
  `trustedCapabilities` are preserved verbatim.
- Only packages whose integrity CHANGES have their artifact replaced and
  their `trustedCapabilities` reset to `[]`.
- All validation (manifests, cycles, identity and capability-ID collisions,
  compatibility) completes against a staging area BEFORE any destination
  mutation; the artifact swap + lock write happen only after full-closure
  validation. On any failure before that point the staging area is removed
  and the destination store + lock are byte-identical to the pre-operation
  state.
- Restore is per-package transactional: a package restore failure
  (`integrity-drift`, `capability-list-mismatch`) leaves that package absent
  or untouched — never partially installed — and does not affect other
  packages' restores.

## 4. Runtime-validated schema invariants

JSON Schema cannot express these in the current shapes, so they are normative
SEMANTIC validation rules with tests; validators of the schemas alone are not
complete:

- `oas-package.json`: at most one `configs.*.default === true` per manifest →
  `invalid-package-manifest` (enforced in `loadPackageManifestAt`; rejection
  fixture in `test/packages.test.mjs`).
- `oas-lock.json` v2, validated before restore and before trust operations →
  `invalid-lock`:
  - `trustedCapabilities` ⊆ `capabilities` per entry;
  - every `dependencies[]` id is a key of the same lock's `packages` map;
  - `source`/`commit` pairing: `git:`/`catalog:` sources require a 40-hex
    `commit`; `path:` sources require `commit: "local"`.

`invalid-lock` joins the error taxonomy of the main contract (§4).
