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

- **Versioning** (maintainer ruling): the boundary is versioned by the
  **compatibility floor plus a pinned consumer fixture** — the boundary (and
  lock v2) ships in kernel **0.19.0**; official packages consuming it declare
  `compatibility.oas: ">=0.19.0"` in `oas-package.json` (and capability
  `compatibility.oas` likewise), and each consumer repo pins the kernel
  consumer-fixture version its CI probes against. The exact Desktop
  `oas version --json` probe payload is NOT extended (no `packageRuntimeApi`
  field) — Desktop API compatibility is a separate contract.
- Kernels below the floor are rejected by the consumer's normal
  compatibility check (`incompatible-oas` at acquire; the consumer fixture
  asserts the rejection).

### Commands (exact surface, boundary v1 — maintainer-ruled minimal)

The public boundary is HIGHER-LEVEL than the private core calls it replaces:
private `findAgent`/`upsertLocalAgent`/`spawnInstance`/`resolveOasConfig`
usage maps onto capability-defined agents, `oas spawn`, and dispatch-provided
settings — not onto one-for-one public equivalents. File-of-record for the
consumer inventory: `packaging/oas-okf/KERNEL-API-NEEDS.md` on kernel branch
`integrations-expert/official-packages-staging` @ `60d5eb6` (design input;
this contract remains authoritative).

1. **Capability-defined agents own lookup/registration/ephemerality.** A
   package capability declares its service agents in its manifest `agents:`
   (package-relative soul dirs, e.g. oas.okf ships
   `agents/memory-harvest/{soul.yaml,AGENTS.md}`). `oas spawn <agent>`
   resolves capability-defined agents for the active context, scaffolds a
   fresh soul homed locally, and applies ephemeral (`kind: "capability"`)
   semantics automatically. There is NO public `oas agent show`,
   `oas agent upsert`, or generic `--ephemeral` flag — add such a surface
   only when a reusable use case proves it.
2. **Spawn** — `oas spawn <agent> ... --json` with the EXISTING flags:
   `--purpose <slug>` (deterministic derived naming
   `<agent>-<purpose>`; no raw instance-name authority), `--parent`,
   `--repo`, `--work attached|worktree|checkout|workspace`, `--work-dir`,
   `--branch`, `--model`, `--task`/`--task-file` (owner-only tempfiles:
   mode 0600, removed on every outcome). Existing validation and error codes
   (`E_BAD_ARGS`, `E_PARENT_NOT_FOUND`, `E_SPAWN_FAILED`, ...) are part of
   the contract; result is the fixed Desktop CLI API v1 spawn shape
   (`{ instance, agent, home, work, tmux, ... }`). If an accepted consumer
   mode cannot be expressed by an existing flag, ONE narrow flag is added
   with JSON tests — never a general override.
3. **Settings via dispatch** — `oas <namespace> <command>` passes the active
   capability's EFFECTIVE settings to the dispatched process as
   `OAS_SETTINGS` (JSON; from the instance metadata snapshot or the resolved
   context), the same contract lifecycle hooks already have. Capabilities
   read their settings (e.g. oas.okf's `harvest-model`) from `OAS_SETTINGS`;
   there is NO public resolved-config read command.
4. **Consumer rules**: a package command invokes the installed/selected
   `oas` CLI from PATH, parses the one schema-v1 envelope, emits its own
   envelope, and never imports `lib/core.mjs` or calls `oas root` for
   kernel-file resolution.

Error codes are part of the contract: `E_USAGE`, `E_BAD_ARGS`,
`E_UNKNOWN_COMMAND`, `E_SPAWN_FAILED`, `E_PARENT_NOT_FOUND`,
`E_RELATIVE_NOT_FOUND`, `E_RELATIVE_AMBIGUOUS`, `E_CAPABILITY_BLOCKED`,
`E_CAPABILITY_INACTIVE`.

### Consumer fixture

The engine ships a consumer fixture driving the full oas.okf pattern
exclusively through this surface: a capability-defined `memory-harvest`
agent resolved and spawned via `oas spawn --json` in all three source modes
(local-soul / workspace-mode / repo-resident), parent relation,
purpose-derived naming + debounce, model via `OAS_SETTINGS` dispatch,
task-file privacy/cleanup, clean JSON success/failure, no private
import/`oas root` lookup, Pi + Claude scaffold parity, and sub-floor kernel
rejection. WS3 reuses the fixture shape as each official repo's per-repo CI
probe, combined with the acquire → lock → trust → activate → spawn probe
from `test/packages.test.mjs`. (The oas.okf tree changes themselves —
`agents/memory-harvest`, dropping the core import — are WS3 deliverables.)

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
  are `.git` and `oas-lock.json`). The MATERIALIZED closure is bound
  separately: the lock records `depsIntegrity`, a deterministic digest of
  every materialized `node_modules` tree under the package root (absent for
  an empty closure). Trust verifies BOTH digests — tampering a materialized
  dependency invalidates capability approvals exactly like source drift.
  `npm ci` fails closed on any lockfile mismatch. Doctor reports source
  integrity + the materialized-closure state.
- **Reproducibility**: `node_modules` is a derived, platform-dependent
  artifact — never part of the SOURCE hash, never committed, always
  reproduced from the locked `package-lock.json` on the host platform, then
  verified against the locked `depsIntegrity`. Platform-dependent closures
  (native builds) will produce platform-specific digests; v1 packages should
  prefer pure-JS closures (the official set qualifies).
- **Containment**: capability code/hook paths must resolve inside the locked
  package root after symlink resolution; materialized `node_modules` trees
  under that root (package-root or per-capability) are inside the boundary by
  construction. Paths escaping the root — including through `node_modules`
  symlinks — are `path-escape`.
- **Rollback**: materialization happens IN STAGING before any destination
  mutation; a materialization failure fails the whole acquire/update
  transaction with the store and lock unchanged, and a restore whose
  re-materialized closure does not reproduce the locked `depsIntegrity`
  fails as `integrity-drift` with the prior artifact left in place. Staging
  directories are removed wholesale on any failure.

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
