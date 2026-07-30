# Package-runtime API contract (addendum to the package-engine contract)

Status: **FROZEN** for the capability-materialization delivery, as an addendum to
[`package-engine-contract.md`](./package-engine-contract.md). It answers the
maintainer's four clarifications on the M1 freeze (maintainer review of
1db919b): the public package-runtime boundary, the npm runtime closure,
incremental transaction semantics, and runtime-validated schema invariants.
Changes go through the coordinator to the maintainer.

**What capability materialization changed here.** §1 (the public CLI boundary) is
unchanged. §2 keeps every npm rule and moves the materialization root from the
package root to each declared *capability* root, because the closure now lives
inside the materialized artifact. §3 becomes incremental with respect to the
*capability store*. §4 states the current lock invariants and the prototype-safety
requirement. §5 records that a `"."` capability root is read compatibility only,
discriminated by `configTemplates` rather than `configs`. §6 records that v1 is
the only legacy format supported, and that the earlier transitional package-root
`lockfileVersion: 2` is unsupported input rather than something to migrate.

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
commands/hooks execute the CLI at the exact absolute path the dispatcher
provides in `OAS_CLI_BIN` (§1 item 4) — never by resolving `oas` from PATH,
which is untrusted inside worktrees.

### Envelope and versioning

Every boundary command supports `--json` with the Desktop CLI API v1 envelope:
exactly one JSON object on stdout — `{ schemaVersion: 1, ok: true, result }`
or `{ schemaVersion: 1, ok: false, error: { code, message } }` — nonzero exit
on failure; progress prose only on stderr.

- **Versioning** (maintainer ruling): the boundary is versioned by the
  **compatibility floor plus a pinned consumer fixture** — the boundary shipped
  in kernel **0.19.0** and is unchanged by capability materialization; the
  materialized store and the capability-materialization lock (which REPLACES the
  earlier package-root spelling in place and remains `lockfileVersion: 2`) raise
  the floor for packages that rely on the new manifest surface
  (`configTemplates`, dedicated capability roots), which
  declare the materialization release's floor instead. Official packages declare
  their floor as `compatibility.oas: ">=<floor>"` in `oas-package.json` (and
  capability `compatibility.oas` likewise), and each consumer repo pins the kernel
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
4. **Consumer rules**: a package command executes the CLI at the exact
   absolute path the dispatcher provides in the **`OAS_CLI_BIN`** environment
   variable (part of the dispatch env contract, beside `OAS_SETTINGS`), via
   `execFile` on that path — **never** by resolving `oas` from `PATH` and
   never through a shell: PATH is not a trusted runtime boundary, and package
   commands run in worktrees where it can be shadowed. The consumer parses
   the one schema-v1 envelope, emits its own envelope, and never imports
   `lib/core.mjs` or calls `oas root` for kernel-file resolution.

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

## 2. Capability-local npm runtime closure

- **Detection and placement**: materialization roots are the manifest-declared
  CAPABILITY roots — each one carrying BOTH `package.json` AND
  `package-lock.json` is materialized independently, and the resulting
  `node_modules` becomes part of that capability's materialized artifact. This
  is what lets an inner `oas.json` resolve resources via `node_modules/...`
  relative to its own manifest (e.g. oas-aweb's
  `node_modules/@awebai/pi/skills/...`) inside a self-contained artifact.
  A **package-root-only** closure has no durable home and is NOT
  materialized: it is package tooling. If a capability actually depends on it,
  self-containment fails and the package is rejected
  (`capability-not-self-contained`) rather than silently installing a broken
  artifact. For a legacy `"."` capability root the capability root *is* the
  package root, so that package-root lock is the capability's own closure (it is
  detected once, not twice). Directories not enumerated by the manifest are
  never scanned.
- **When and how**: materialization runs IN STAGING during acquire, update and
  restore, after payload integrity verification and BEFORE the capability
  artifact's integrity is computed or swapped in. The command is exactly
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
- **Integrity coverage**: the lock has TWO digests at two levels, and the
  closure sits inside one of them.
  - The package row's `integrity` covers the staged package PAYLOAD only —
    every `node_modules` (at any depth) and a root `oas-lock.json` are excluded,
    so it is stable whether or not materialization has run. Root source-control
    metadata (`.git`) is stripped before staging; if it later appears in a
    managed artifact it is ordinary drift, not an integrity exclusion.
  - The capability row's `integrity` covers the MATERIALIZED ARTIFACT with **no
    exclusions at all**: capability source bytes, the materialized
    `node_modules`, and the generated `.oas-installation.json` provenance file.
  - There is consequently NO separate dependency digest anywhere in the model —
    tampering with a materialized dependency changes the capability artifact
    integrity directly, which invalidates `trusted` exactly like source drift and
    makes bare restore reproject. A lock row carrying `depsIntegrity` is
    evidence of the unsupported transitional shape (contract §4.1), not a field
    to honour.
  - `npm ci` fails closed on any lockfile mismatch. Doctor reports the package
    payload integrity and each capability artifact's integrity/trust state.
- **Reproducibility (v1 MUST: platform-invariant closures)**: `node_modules`
  is a derived artifact — never part of the package payload hash, never
  committed, always reproduced from the locked `package-lock.json` and verified
  through the capability artifact integrity that contains it. Because that
  single artifact digest lives in a shared lock, **v1 packages MUST have
  platform-invariant materialized closures**: no native builds, no
  platform-specific optional dependencies, no install-time variance of any kind.
  A closure that cannot materialize byte-identically across supported platforms
  is UNSUPPORTED in v1 — the package must vendor a pure-JS closure or drop the
  dependency; official dependency-bearing packages gate this across their
  published platforms in CI. The engine ENFORCES this at materialization as a
  transaction-wide preflight PLUS a post-materialization scan: every
  materialization root's lockfile (every declared capability root, kept and
  fresh) is scanned BEFORE any `npm ci` — only entries in the materialized
  non-dev/non-peer closure are evaluated (omitted metadata cannot fail an
  otherwise valid closure); an INCLUDED entry with os/cpu/libc constraints,
  optional-dependency variance, or an install script is rejected (an included
  install script is disallowed even though `--ignore-scripts` inerts it — the
  runtime almost certainly expects the artifacts it would have built). After
  `npm ci`, before digest/swap, the materialized tree is scanned for `.node`
  native binaries alongside symlink containment. npm lockfileVersion 1 (no
  `packages` map) fails closed — regenerate with modern npm. (A future keyed
  per-platform closure map may relax this.)
- **Containment**: capability code/hook/skill/agent paths must resolve inside
  the CAPABILITY root after symlink resolution — that is what makes the
  materialized artifact self-contained and independently hashable. Materialized
  `node_modules` trees under that root are inside the boundary by construction —
  and ENFORCED: after `npm ci`, before any digest or swap, every symlink under
  every materialized `node_modules` is realpath-checked to resolve inside the
  capability root; a broken or escaping link fails the transaction
  (`path-escape`) with full rollback. Node import resolution follows symlinks,
  so this check is global, not best-effort.
- **Rollback**: materialization happens IN STAGING before any destination
  mutation; a materialization failure fails the whole acquire/update
  transaction with the capability store and lock unchanged, and a restore whose
  reprojected artifact does not reproduce the locked capability `integrity`
  fails as `integrity-drift` with the prior artifact left in place. Staging
  directories are removed wholesale on any failure.

## 3. Incremental transaction semantics

Acquire/update of one package closure is **incremental with respect to the
scope's capability store**, never a wholesale store replacement:

- Capability artifacts, package rows and capability rows belonging to packages
  NOT in the resolved closure are untouched — bytes on disk and lock JSON both.
- Within the closure, a capability whose newly projected artifact integrity
  EQUALS its currently locked integrity is kept in place ("kept" in reports) and
  its `trusted` flag is preserved verbatim.
- Only capabilities whose artifact integrity CHANGES have their artifact
  replaced and their `trusted` reset to `false`. Trust is per capability, so an
  unchanged capability inside a changed package keeps its approval.
- All validation (manifests, self-containment, cycles, identity and
  capability-ID collisions, compatibility, platform invariance) completes against
  a staging area BEFORE any destination mutation; the artifact swaps and the lock
  write happen only after full-closure validation. On any failure before that
  point the staging area is removed and the destination store + lock are
  byte-identical to the pre-operation state.
- An update replaces ALL of one package's exports together or none of them; a
  removed export is retired only when no config references it (otherwise
  `remove-blocked`, with nothing changed).
- Restore is per-capability transactional: a failure (`integrity-drift`,
  `capability-list-mismatch`) leaves that capability absent or untouched — never
  partially installed — and does not affect other capabilities' restores.

## 4. Runtime-validated schema invariants

JSON Schema cannot express these in the current shapes, so they are normative
SEMANTIC validation rules with tests; validators of the schemas alone are not
complete:

- `oas-package.json`:
  - `capabilities` is REQUIRED and non-empty — config-only and empty packages
    are `invalid-package-manifest`;
  - `configTemplates` is OPTIONAL and is the canonical spelling; `configs` is a
    deprecated read-only alias; both spellings normalize to one descriptor shape
    carrying a diagnostic `legacySpelling`, and carrying BOTH is
    `invalid-package-manifest`;
  - a `"."` capability root is accepted only when the manifest does NOT carry
    `configTemplates` (§5), and remains exclusive with any other capability path;
    authoring never emits it;
  - at most one `configTemplates.*.default === true` (equivalently
    `configs.*.default`) per manifest → `invalid-package-manifest`;
  - `compatibility.oas` is REQUIRED with exactly the grammar `>=x.y.z`,
    `^x.y.z`, or `x.y.z` — schema and runtime agree; malformed/missing →
    `invalid-package-manifest`, valid-but-unsatisfied → `incompatible-oas`;
  - every declared capability must be projectable self-contained — each declared
    resource exists and realpath-resolves inside its own capability root →
    `capability-not-self-contained` / `path-escape`. JSON Schema cannot see this
    at all: it is a filesystem property of the staged payload.
- `oas-lock.json`, validated BEFORE restore, trust/approval, update/remove
  planning, migration planning, the locked-template reader, and doctor/list
  consumption → `invalid-lock` (fail closed before executable approval or
  artifact replacement; no normalization, no auto-repair, NO side effects;
  message/provenance carry lock file, package or capability identity, and the
  violated field/edge):
  - both top-level `packages` and `capabilities` maps are required;
  - `dependencies` is required on every package row (empty array when none), so
    a reader never distinguishes absent from empty;
  - normalized source prefix (`git:`/`path:`/`catalog:`) and source/commit
    pairing: `path:` requires `commit: "local"` AND `path: "."`; `git:`/`catalog:`
    require an exact 40-hex `commit`;
  - canonical `path` spelling on both row kinds — a non-canonical spelling is
    invalid, never repaired;
  - every `capabilities.*.package` is a key of the same lock's `packages` map
    (the provider back-reference is the single truth for which capabilities a
    package supplies — package rows never list them);
  - every `packages.*.dependencies[]` id is a key of the same lock's `packages`
    map; no self-dependency and no cycle in the locked dependency graph;
  - `trusted` is a boolean, and it is the ONLY trust field: there is no
    package-level approval anywhere in the model;
  - `integrity` digests are well-formed sha256 on both row kinds;
  - arrays retain schema uniqueness (no duplicates);
  - `.oas-installation.json` inside a materialized artifact must AGREE with the
    capability and package rows it was projected from (§3.1 of the contract);
    disagreement is `invalid-lock`, modification is `integrity-drift`;
  - the unsupported transitional v2 shape is rejected centrally by the exact
    predicate of contract §4.1, using direct raw lock-scope reads rather than
    `configChain` so lock-only scopes are visible, with own-property presence —
    never truthiness or array length — as the row test;
  - v1 documents are validated against their own historical shape when read, so
    migration planning and doctor operate on verified data.

**Prototype safety is required at EVERY lookup or membership check keyed by a
package or capability ID** — central read, dependency graph, provider
resolution, trust, approval, update and remove alike, not merely at the
transitional tell fields. Raw parsed JSON objects return inherited
`constructor`, `toString` or `valueOf` for `map[id]` even when no own entry
exists, so identity keys are charset-validated and every map is null-prototype
or accessed through `Object.hasOwn`. A prototype-named or hostile raw-JSON ID
must never impersonate a provider, a dependency or a trust entry, nor bypass a
membership check. Fixtures cover empty transitional arrays and falsey values
plus prototype-named package AND capability IDs across central read, graph,
provider and trust lookups.

Fail-closed enforcement points: `parseLockFileStrict`, `readPackageLocks` and
`listInstalledPackages` RAISE `invalid-lock` — consumers never see invalid
locks as absent or usable data; `writePackageLock` and
`writeCapabilityLockEntry` validate the complete prospective document (both
maps, together) before writing; restore, trust queries, approval, update/remove
planning, migration planning and the locked-template reader validate before
acting. Doctor (human and `--json`) catches the typed error and renders the
actionable diagnosis — it is the only consumer that continues past an invalid
lock, and it never uses the invalid data.

`invalid-lock` joins the error taxonomy of the main contract (§8).

## 5. Flat single-capability packages (`capabilities: ["."]`)

**Read compatibility only.** A capability directory may BE the package root —
`oas-package.json` and `oas.json` side by side with `capabilities: ["."]` — in
an already-published manifest. The discriminator is `configTemplates`, NOT
`configs`: `oas.authoring@1.0.0` is `capabilities: ["."]` and ships no template
map at all, so keying acceptance on the deprecated spelling would strand a
package the kernel is required to keep reading. A manifest carrying
`configTemplates` is unambiguously new and its `"."` is
`invalid-package-manifest`; authoring tooling never emits `"."` either way.
Semantics for the layouts that still exist:

- **The projection is still a capability artifact.** The capability root equals
  the package root, so the materialized artifact under
  `.agents/capabilities/installed/<id>/` contains the whole package root
  including `oas-package.json` and any config templates. That is a superset, not
  a leak: everything in it is validated payload from one exact locked source,
  and the artifact remains self-contained, independently hashable and
  independently trustable. Its `integrity` is the artifact hash like any other.
- **Two digests, no double counting.** The package row's payload `integrity` and
  the capability row's artifact `integrity` cover overlapping bytes on purpose:
  one proves the distribution, the other proves the installation. Trust binds to
  the capability digest only.
- **Resource indexing**: only the manifest-declared `.` is indexed; `oas.json`
  loads from the root with normal capability validation. `oas-package.json`
  living inside the capability's file set is harmless — each file has exactly
  one loader (`oas-package.json` → package manifest, `oas.json` → capability
  manifest), so no manifest-kind ambiguity can arise.
- **Constraint**: `.` implies a SINGLE-capability package. Listing `.` together
  with any other capability path would nest one capability inside another and is
  rejected as `invalid-package-manifest`.
- Per-capability npm closures (§2) degenerate to the package root: a root
  `package.json` + `package-lock.json` pair is the capability's closure (it is
  detected once, not twice).
- **Fail rather than degrade**: if such a package's capability cannot be
  projected self-contained, acquisition and migration fail
  (`capability-not-self-contained`) instead of silently retaining package-only
  paths.

## 6. Legacy locks: v1 compatibility, and no transitional-v2 compatibility

There is exactly one legacy format to support, and it is v1.

1. The kernel **writes only** the capability-materialization lock.
   `writePackageLock` and `writeCapabilityLockEntry` refuse an existing v1
   file — **including an empty one** — with `legacy-lock`. Only an ABSENT lock
   is a fresh document; an empty v1 file still carries a format decision the
   user has not made, and converting it implicitly would contradict explicit
   migration.
2. **v1 stays usable.** Runtime discovery, exact restore, trust checks,
   approval updates and doctor/list diagnosis keep working against v1 locks and
   the existing v1 artifacts in `.agents/capabilities/installed/`. Ordinary use
   of an unconverted deployment never requires migration; only lifecycle
   mutation through the package surface does. `readPackageLocks` surfaces v1
   files in `legacy` and in `migration` (with kind `v1` or `v1-empty`), and
   nothing is normalized, repaired or rewritten on read.
3. **Conversion is explicit, transactional and all-or-nothing per scope.** The
   lock has no residue container, so a v1 scope with even one unmappable entry
   stays v1 in full — reported as `hold`/`manual` — and keeps working.
   Re-running `oas migrate` retries it once the catalog can map it. Guided
   official migration converts directly into flat capability materialization.
4. **Trust is never carried over from v1.** A v1 capability artifact and a
   materialized artifact are different bytes, so every executable surface is
   re-earned and listed in the returned `trust[]`.
5. **Rollback is byte-exact.** Any conversion failure restores the original v1
   lock byte-identically, removes every artifact the conversion created, leaves
   superseded v1 artifacts in place, and rolls back the ignore bytes. Owned/path
   capabilities are never touched.
6. **The earlier transitional package-root v2 is not supported at all.** It is
   detected centrally by contract §4.1 and rejected as `invalid-lock` with an
   actionable message naming the unsupported shape and scope recreation. It is
   never converted, never partially interpreted, and there is no
   `.agents/packages/installed/` handling, offline projection, or trust
   carry-over anywhere in the engine. Existing local pre-adoption state is
   recreated by reinstalling. The one exception is the state-free empty
   document `{ "lockfileVersion": 2, "packages": {} }`, which carries no state
   and normalizes to the empty current lock.
7. **Cutover gate**: zero lockfileVersion 1 files (including empty
   `{capabilities:{}}` ones) and zero `.agents/packages/` directories across
   every reconciled scope. Doctor reports each remaining one with its exact
   command.

Required engine tests (`test/package-engine.test.mjs`): v1 empty file stays
pending (never implicitly converted), v1 partial-mappability hold with the scope
untouched, v1 full conversion with trust not carried, byte-exact rollback on
failure, unsupported transitional v2 rejected with no side effects (both
predicate arms, including empty transitional arrays and a dependency-free old
row), state-free empty transitional v2 normalization, prototype-named package
and capability IDs across central read / graph / provider / trust lookups, and
`.oas-installation.json` determinism, field agreement, tamper failure and
future-kernel restore.
