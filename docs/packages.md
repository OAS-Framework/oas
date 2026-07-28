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

## Doctor

`oas doctor` reports, in addition to its capability diagnostics:

- **Distribution packages** visible in lock v2 (`packages:` in
  `oas-lock.json`), with source and exported capabilities;
- **profile provenance** of any adopted snapshot in the chain;
- **available-but-unapplied profiles** — a locked, installed package exporting
  config profiles that no scope has adopted;
- **missing host commands** for active capabilities, with the exact consent
  command when a safe installer exists.

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
