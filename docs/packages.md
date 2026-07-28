# Distribution packages — config profiles, workspace reconciliation, and host requirements

An **OAS distribution package** is the install/update/review unit above
capabilities: one or more independently targetable capabilities plus one or
more reference config **profiles**, described by an `oas-package.json` at the
package root. The package layer's engine (acquisition, store, lock v2,
per-capability trust) is documented in its own workstream; this document
covers the config side: adopting profiles, whole-workspace reconciliation,
and consented host-requirement installs.

A Git repository **contains** a package rather than being one. Which
directory holds it is part of the source contract:

```bash
oas install git:github.com/org/repo@v1.0.0            # → repo's oas-package/  (the DEFAULT)
oas install git:github.com/org/repo@v1.0.0#dist/oas   # → repo's dist/oas/
oas install git:github.com/org/repo@v1.0.0#.          # → the repository ROOT
oas install /repo/custom-root                         # local: that EXACT directory
```

Official examples, scaffolds and conventions use `oas-package/`; catalog
entries carry their own `path`; local paths take no fragment and never apply
the default. Only the selected subtree is installed and hashed, so repository
docs, CI configuration, owner souls and sibling packages stay outside the
package's installed bytes and integrity. One repository may ship several
packages at different paths. The lock pins the selected root in its own
`path` field, and only an explicit `oas update <package>` may move it — see
[`design/package-engine-contract.md` §1.1](design/package-engine-contract.md).

Ground truth for the contract: the accepted Decision "Distribution packages,
config profiles, and consented host requirements".

## Package config profiles (`oas init --package`)

A profile is a complete reference `oas-config.yaml` shipped by a package and
enumerated in `oas-package.json` under `configs:`. Adopting one is explicit:

```bash
oas init --package example.engineering                 # official catalog id (latest)
oas init --package example.engineering@1.2.0           # catalog id + pinned selector
oas init --package ../engineering-oas --config minimal # local path + explicit profile
oas init --package https://example.invalid/pkg.git     # git URL (default branch)
```

Behavior:

- **Preview + validation first.** The profile must be valid against the config
  schema; every `from: installed` capability it references must be supplied by
  the package or its dependency closure; layer bindings must agree with the
  capability manifests; agent types must be syntactically valid; and no path
  (injection overrides, work-mode setup scripts) may escape the target scope.
  A failing profile is never written.
- **Default selection.** A profile marked `"default": true` is chosen when
  `--config` is omitted; a single profile is chosen implicitly; multiple
  unmarked profiles require `--config <name>`.
- **Overwrite refusal.** `oas init --package` refuses when an
  `oas-config.yaml` already exists at the scope.
- **Provenance.** The snapshot's first line records package, version/commit,
  and profile:

  ```yaml
  # package: example.engineering@0123456789ab profile: default (snapshot — …)
  ```

### The snapshot is yours (adopter sovereignty)

The adopted config is an **ordinary scoped config** — not live inheritance,
not ambient package policy. `oas use`, `oas type`, `oas inject eject`, and
hand edits keep their meaning; package updates never rewrite the snapshot.
Every capability exported by an installed package stays individually
addressable: you may

- **retarget** a capability from global to an agent type or soul
  (`oas use example.review --type reviewers`);
- **disable** something the profile enabled
  (`oas use example.review --global --disable`, or `knowledge: none` for a
  layer);
- **re-set settings** per family (`oas use example.review --soul dev
  --settings depth=high`);
- **replace** an exclusive-layer provider with another capability; and
- **override from a nested repository** — a closer repo's `oas-config.yaml`
  wins per the normal cascade, e.g.:

  ```yaml
  # member-repo/oas-config.yaml — this repo opts out of the workspace default
  name: member
  capabilities:
    layers:
      knowledge: none
  ```

Nothing a package ships is mandatory; the resolved local config is always
authoritative.

### Diffing against the package (`oas config diff`)

Snapshots deliberately drift from newer package defaults. To see how:

```bash
oas config diff --package example.engineering --config default
oas config diff          # the snapshot's provenance header supplies defaults
```

The diff is **report-only** — lines prefixed `+` exist only locally, `-` only
in the package's current profile. Nothing is merged or overwritten; adopt
changes by hand if wanted.

## Workspace reconciliation (bare `oas install`)

At a config scope that declares `team:`, bare `oas install` reconciles the
whole workspace instead of only the ancestor chain:

1. prints the chosen boundary **before any network or host work**;
2. restores the boundary scope's locked graph;
3. discovers descendant scopes containing `oas-config.yaml` or
   `oas-lock.json`, in deterministic path order, pruning `.git`, generated
   stores (`.agents/`), dependency/vendor directories (`node_modules`,
   `vendor`, virtualenvs), agent instances/worktrees, `local-agents/`, and
   **nested team boundaries** (each is its own reconciliation unit);
4. restores each descendant scope once;
5. validates that every config-referenced installed capability is supplied by
   a visible locked package (or capability lock); and
6. aggregates missing requirements and failures **by scope**.

At a non-team scope, bare `oas install` keeps current-chain behavior. Pass
`--recursive` to request descendant reconciliation outside a team boundary —
the boundary is still printed first. OAS never scans downward from the
laptop/home config by default.

## Host requirements — a separate consent gate

A capability `requires` entry may declare structured, platform-aware install
methods (the legacy `install: "https://…"` docs URL still works):

```json
{
  "command": "example-cli",
  "why": "send and receive team messages",
  "install": {
    "docs": "https://example.invalid/install",
    "methods": [
      { "platform": "darwin", "manager": "npm-global", "package": "@example/cli@1.2.3" }
    ]
  }
}
```

Rules (all enforced):

- **Allowlisted managers only**: `npm-global` and `brew`
  (download-with-checksum is declared but not implemented yet). Recipes are
  data — argv arrays, never shell snippets; no sudo, no shell metacharacters,
  no authentication.
- **Informed, per-requirement consent.** Interactive `oas install` shows the
  exact command, source, version, and whether it changes user- or
  machine-level state, then asks per requirement. A plan may take **more than
  one command** — a runtime package can need its source registered first — so
  both the human and `--json` renderings carry `steps`, the ordered argv
  sequence that will actually run, alongside `argv` (its final command). What
  you consent to is the whole sequence; nothing is executed that the plan did
  not show.
- **Aggregation is scoped**: only capabilities *activated somewhere in the
  reconciled scopes* are considered, deduplicated by required command, and the
  report names which capabilities requested each command.
- **Noninteractive runs never install by default.** Automation names each
  accepted requirement: `oas install --accept-requirement example-cli`.
  `--no-requirements` restores packages only (CI). A **consented** install
  that fails (manager error, or the command still absent from PATH) makes
  `oas install` exit nonzero so automation can detect it; unaccepted/skipped
  requirements stay non-fatal.
- **PATH verification** runs after each install; a tool that does not land on
  PATH is reported honestly.
- **Skipping is safe**: `oas doctor` keeps an actionable warning (the consent
  command to run) until the command is on PATH.
- **Trust and requirement consent are distinct gates**: installing a binary
  neither activates nor approves any capability, and capability trust never
  authorizes host installs.

When no safe recipe matches the host, OAS prints the documented install URL.

## Upgrading a 0.18 deployment to the official packages

Deployments created before official packages existed hold ordinary
`oas-config.yaml` files, **v1** `oas-lock.json` files and acquired capability
artifacts under `.agents/capabilities/installed/`. Those keep working: a valid
v1 lock still restores, activates, trusts and spawns, and nothing about
installing this release migrates anything.

The upgrade is one explicit, guided command:

```bash
oas migrate --official --recursive --dry-run --dir <team-root>   # plan first
oas migrate --official --recursive --dir <team-root>             # apply
```

- **Scope discovery** is deterministic and covers every *visible* lock-owning
  scope: the explicit scope's ancestor chain (so an outer repo/laptop lock the
  deployment actually reads is migrated too), the team boundary, and descendant
  config/lock scopes found with reconciliation's pruning (nested team
  boundaries stay self-owned). Scopes are planned and applied in path order,
  ancestors first. Without `--recursive` only the named scope is migrated.
- **Plan first, always.** The complete per-scope plan is printed (and available
  as stable JSON) before anything is applied; `--dry-run` stops after it.
- **Which package supplies which capability is catalog data**, never code. The
  catalog maps identity by default (capability `oas.okf` → package `oas.okf`)
  and carries explicit aliases for capabilities a package exports under another
  identity (`oas.review` → package `oas.dev`). See the catalog shape below.
- **Config files are not rewritten.** Packages export the same capability ids,
  so activation, layer bindings, targets, settings, exclusions and injection
  overrides remain valid byte-for-byte.
- **Held, not half-converted.** If this release's catalog cannot map every
  official capability at a scope, that scope is left completely untouched and
  the run reports it as held with a nonzero exit — legacy capabilities keep
  working until the mapping publishes.
- **Custom entries are untouched.** `git:`/`path:`/unknown v1 sources are never
  acquired by the guided mode: they are kept exactly as they are (as residue in
  a scope that converts for its official capabilities, and untouched in a scope
  with no official capabilities at all). Plain `oas migrate` still maps custom
  sources and creates residue when asked.
- **Per scope transactional.** Each scope acquires its package closure, writes
  its v2 lock, and only then removes the superseded v1 artifacts. A failing
  scope is rolled back byte-identically; other scopes keep their (truthfully
  reported) result and the aggregate exit is nonzero.
- **Trust is re-earned, never transferred.** Package integrity is not the v1
  artifact's integrity, so approvals do not carry over: the run prints the exact
  `oas trust <capability> --dir <scope>` commands, then the bare
  `oas install --dir <scope>` pass (already-installed host requirements verify
  and are not reinstalled; anything missing gets its
  `oas install --accept-requirement <cmd>` consent command).

Rerunning the command after a successful migration changes nothing.

### Catalog shape

The official catalog is data (`package-catalog.json`, or the file named by
`OAS_PACKAGE_CATALOG`):

```json
{
  "packages": {
    "oas.okf": { "url": "https://github.com/org/oas-okf", "ref": "v2.0.0", "path": "oas-package" },
    "oas.dev": { "url": "https://github.com/org/oas-dev", "path": "oas-package" }
  },
  "capabilities": { "oas.review": "oas.dev" }
}
```

`packages` is identity + discovery only — resolving through it never advances a
lock and never grants executable trust. `capabilities` is the legacy-capability
→ package alias map the guided migration reads; identity mappings need no
entry. An alias value may also be spelled `{ "package": "<id>" }`.

## Doctor

`oas doctor` reports, in addition to its capability diagnostics:

- **Distribution packages** visible in lock v2 (`packages:` in
  `oas-lock.json`), with source and exported capabilities;
- **profile provenance** of any adopted snapshot in the chain;
- **available-but-unapplied profiles** — a locked, installed package exporting
  config profiles that no scope has adopted;
- **missing host commands** for active capabilities, with the exact consent
  command when a safe installer exists;
- **official capability migration** (`officialMigration` in `--json`) when the
  chain still holds legacy `marketplace:` locks: each capability with the
  package that supplies it, and either `ready` with the exact
  `oas migrate --official --recursive --dir <boundary>` command, or
  `unavailable` with the reason — the catalog has no mapping yet and the legacy
  capabilities remain supported.

## Engine integration

The package engine (acquisition, store, lock v2, exact restore, capability
indexing, per-capability trust — see `docs/design/package-engine-contract.md`
and `docs/design/package-runtime-api.md`) is merged: `oas init --package`
acquires and exact-locks the full closure through the engine's
`acquirePackage` for every source kind (git, catalog, local path); the
team-boundary reconciliation described above wraps the engine's
`restorePackages` (current-chain exact restore, integrity/capability/runtime-
closure verification) as its per-scope primitive; profile resolution reads
the engine's indexed store. Legacy v1 capability locks keep restoring via the
capability path and are reported as LEGACY with the `oas migrate` pointer.
