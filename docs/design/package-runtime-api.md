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
`resolveOasConfig`; no other official package imports core). File-of-record
for the consumer inventory: `packaging/oas-okf/KERNEL-API-NEEDS.md` on kernel
branch `integrations-expert/official-packages-staging` @ `60d5eb6` (design
input; this contract remains authoritative).

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
- **When and how**: materialization runs at the END of a successful acquire,
  update, and restore of that package (after integrity verification, before
  the operation reports success). The command is exactly
  `npm ci --omit=dev --omit=peer --ignore-scripts` (plus `--no-audit
  --no-fund` noise suppression) per materialization root — **dev AND host
  peer dependencies are omitted**; **no npm lifecycle scripts ever run**, at
  any phase. A package may consume host-provided peer APIs only through an
  explicit supported host boundary (§1) — never by auto-materializing an
  unrelated harness peer into its closure.
- **Closure/integrity/audit scope**: the runtime-closure contract covers the
  ACTUALLY MATERIALIZED production dependency tree, not the full lock
  metadata (a lockfile may describe dev/peer subtrees that are never
  materialized and are out of contract). Vulnerability audit uses the
  identical scope: `npm audit --omit=dev --omit=peer --ignore-scripts`.
  Consumer/package CI must include a fixture asserting omitted peer
  dependencies are ABSENT from the materialized tree.
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

- `oas-package.json`:
  - at most one `configs.*.default === true` per manifest →
    `invalid-package-manifest` (enforced in `loadPackageManifestAt`; rejection
    fixture in `test/packages.test.mjs`);
  - `compatibility.oas` is REQUIRED with exactly the v1 grammar `>=x.y.z`,
    `^x.y.z`, or `x.y.z` — schema and runtime agree; malformed/missing →
    `invalid-package-manifest`, valid-but-unsatisfied → `incompatible-oas`.
- `oas-lock.json` v2, validated BEFORE restore, trust/approval, update/remove
  planning, and doctor/list consumption → `invalid-lock` (fail closed before
  executable approval or artifact replacement; no normalization or
  auto-repair on read; message/provenance carry lock file, package identity,
  and the violated field/edge):
  - normalized source prefix (`git:`/`path:`/`catalog:`) and source/commit
    pairing: `path:` requires `commit: "local"`; `git:`/`catalog:` require an
    exact 40-hex `commit`;
  - `trustedCapabilities` ⊆ `capabilities`;
  - every `dependencies[]` id is a key of the same lock's `packages` map; no
    self-dependency and no cycle in the locked dependency graph;
  - arrays retain schema uniqueness (no duplicates);
  - malformed mixed-v2 legacy residue is DIAGNOSED by doctor (human and
    JSON), never silently repaired and never a trust source.

`invalid-lock` joins the error taxonomy of the main contract (§4).

## 5. Flat single-capability packages (`capabilities: ["."]`)

**Supported.** A capability directory may BE the package root:
`oas-package.json` and `oas.json` side by side with `capabilities: ["."]`.
Semantics:

- **One integrity.** The package lock `integrity` covers the whole root tree —
  including `oas-package.json` itself and every capability file. There is no
  separate capability hash, so nothing double-counts; trust binds to the
  package integrity exactly as for nested layouts.
- **Store/slug unchanged**: the root installs at
  `.agents/packages/installed/<package-id>/` keyed by the package identity;
  the capability's directory equals the package root, and the containment
  boundary is that same root.
- **Resource indexing**: only the manifest-declared `.` is indexed; `oas.json`
  loads from the root with normal capability validation. `oas-package.json`
  living inside the capability's file set is harmless — each file has exactly
  one loader (`oas-package.json` → package manifest, `oas.json` → capability
  manifest), so no manifest-kind ambiguity can arise.
- **Constraint**: `.` implies a SINGLE-capability package. Listing `.`
  together with any other capability path would nest one capability inside
  another and is rejected as `invalid-package-manifest`.
- Per-capability npm closures (§2) degenerate to the package root: a root
  `package.json` + `package-lock.json` pair is the capability's closure (it is
  detected once, not twice).

## 6. Legacy residue in v2 locks (maintainer-approved, binding constraints)

A `lockfileVersion: 2` file MAY carry an optional legacy `capabilities` map —
v1 entries `oas migrate` could not yet map to packages. **Maintainer ruling:
approved as a temporary READ-ONLY migration envelope**, under these binding
constraints:

1. Only explicit `oas migrate` flips pure v1 → v2 and creates/carries
   residue. `install`, `writePackageLock`, restore, and update never
   synthesize new legacy entries (`writeCapabilityLock` in a v2 file may only
   UPDATE an existing residue entry; adding a new one is `legacy-lock`).
2. Migration converts every catalog-mappable entry transactionally and
   retains only entries genuinely unmappable at that moment, preserving exact
   source/version/commit/integrity/`trustedExecutables` semantics. Re-running
   `oas migrate` on a v2 lock retries the residue (later successful
   conversion).
3. A residue capability ID colliding with a package-exported capability at
   the same scope is `duplicate-capability-id` with provenance — no implicit
   winner, no dual execution/trust path.
4. Package operations preserve unrelated residue byte-semantically; legacy
   restore/trust services residue only via the existing exact-integrity path.
   Package trust never inherits `trustedExecutables` from residue.
5. Doctor (human and `--json` `migrationResidue`) identifies each residue
   entry as `pending-migration` with the exact retry action
   (`oas migrate --dir <level>`) or removal guidance.
6. Cutover gate: the official-catalog/kernel-marketplace switch requires ZERO
   residue in the deployment probe. Post-transition, residue is readable only
   for pointed diagnosis/migration — never a discovery source, never a way to
   add legacy capabilities.
7. Migration and rollback are atomic: any conversion failure restores the
   original v1 lock byte-identically and removes every package the migration
   installed.

Required tests (maintainer-named, in `test/packages.test.mjs`): mixed v2,
unmappable retention, later successful conversion, collision failure, trust
non-transfer, rollback.
