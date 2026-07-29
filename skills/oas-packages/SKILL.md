---
name: oas-packages
description: >-
  How to acquire, lock, restore, trust, update, remove, and migrate OAS
  distribution packages with the oas CLI. Use for package sources (git/local/
  official catalog), oas-lock.json v2, migration residue, exact restore,
  per-capability executable trust, runtime dependency closures, or package
  doctor failures. Triggers: "install a package", "oas install", "oas list",
  "oas update", "oas remove", "oas migrate", "oas trust", "lockfileVersion",
  "integrity drift", "package won't restore".
---

# OAS distribution packages

A **package** is the install/update/review unit: one git repo (or local dir)
with an `oas-package.json` exporting one or more **capabilities** (the
activation unit) and optional config templates. Acquiring a package activates
NOTHING — activation stays in `oas-config.yaml` (see the oas-config skill).
Never hand-edit `oas-lock.json` or the stores; every operation below is a CLI
command, and all of them take `--json` (one stdout envelope, stable error
codes) and `--dir <scope>`.

## Sources

```
oas install git:github.com/org/repo@v1.0.0    # git shorthand (ref optional; resolved once, exact-locked)
oas install https://host/org/repo.git@v1.0.0  # raw HTTPS/SSH git URL
oas install ../my-package                     # local path (dev escape hatch)
oas install <catalog-id>                      # official catalog short id (identity only — no auto-trust)
```

### Which directory in the repo is the package?

A git repository CONTAINS a package; it is not one. The package root is the
directory carrying `oas-package.json`, and a git source selects it with a
`#<path>` fragment after any `@ref`:

```
oas install git:github.com/org/repo@v1.0.0            # → repo's oas-package/   (the DEFAULT)
oas install git:github.com/org/repo@v1.0.0#dist/oas   # → repo's dist/oas/
oas install git:github.com/org/repo@v1.0.0#.          # → the repository ROOT
```

- **Omit it and you get `oas-package/`.** Every official example, scaffold and
  convention uses `oas-package/` — never a generic `package/`. A repo whose
  manifest sits at the root needs `#.`; the error message says so.
- **Only the selected subtree is installed and hashed.** Repository docs, CI
  config, owner souls and sibling packages never become installed bytes and
  never affect `integrity` — so editing them cannot invalidate approvals, and
  editing the payload (including a nested capability-agent soul) always does.
- **One repo can ship several packages** at different paths; install each by
  its own source. Two contained roots claiming the SAME package identity still
  fail with `duplicate-package-identity`.
- **Catalog ids take no fragment** — the catalog entry carries `path` itself.
- **Local paths take no fragment either**: `oas install /repo/custom-root`
  treats that exact directory as the package root whatever it is named. There
  is no `oas-package` default for local sources.

The lock records the selected root in its own `path` field, in canonical form
(`.` for a root selection). A bare `oas install` restores the locked
source + commit + **path** + integrity even if upstream moved the directory or
the catalog repointed; only `oas update <package>` may adopt a new path, and it
reports the move. Attempting to move it with a plain `oas install` is refused
with `integrity-drift`.

Local capability development is untouched by all of this:
`.agents/capabilities/owned/<id>` (`from: owned`) and `from: path:<dir>` are
not package sources and are never routed through package paths.

Interim cutover note: official ids that are still KERNEL-MARKETPLACE
capabilities (e.g. `oas.okf` today) route through the legacy capability path
and are trusted at acquisition because they ship with the kernel you already
installed. Once workstream 3 publishes them as catalog packages, the same id
acquires as a package with NO automatic executable trust. Doctor's migration
residue reporting tracks the cutover per scope.

Installing a package MATERIALIZES each capability it exports into
`<scope>/.agents/capabilities/installed/<id>/` (gitignored). There is no
persistent package store. Dependencies declared in `oas-package.json` must be
pinnable (official selector, tag/commit, or path). The whole closure is
exact-locked in the scope's `oas-lock.json` (`lockfileVersion: 2`), which
records two maps: `packages` (source, exact commit, selected path, payload
integrity, dependencies) and `capabilities` (each artifact's version, provider
package, path, integrity, trust).

## Everyday operations

```
oas install                    # bare: EXACT restore of this chain's locks (never advances refs)
oas list [--json]              # packages, exported capabilities, scopes, trust state
oas update <package>           # transactional: temp fetch, closure validation, diff,
                               # artifact+lock replaced together; approvals of every
                               # CHANGED-integrity package are invalidated (unchanged
                               # packages in the closure keep theirs)
oas remove <package>           # refuses while config or dependent packages reference it
```

## Trust

Executable surfaces (commands/hooks) are blocked until approved at each
capability artifact's EXACT integrity:

```
oas trust <capability>                     # approve only that capability
oas trust <package> --all-capabilities     # explicit bulk; prints the full executable surface first
```

Any artifact integrity change (update, drift) resets that capability's trust —
re-review, then re-trust. Skill/instruction/config-only capabilities need lock
integrity but no approval. Official-catalog identity is NOT executable trust.

## Runtime dependencies

A capability may check in `package.json` + `package-lock.json`; OAS materializes
it with `npm ci --omit=dev --omit=peer --ignore-scripts` — production tree only,
no lifecycle scripts. The package payload hash EXCLUDES `node_modules`. The
materialized `node_modules` is instead part of that capability's own artifact
integrity, so tampering with materialized deps resets the capability's trust
just like source drift, and restore re-verifies it. Closures must be
platform-invariant. Host peer APIs are reached only through the supported
runtime boundary, never auto-installed.

## Migration from v1 locks

```
oas migrate --dry-run          # plan: which v1 capability locks map to packages
oas migrate                    # atomic: converts mappable entries, retains the rest
                               # as residue in the revised v2 lock; rolls back on failure
```

Residue entries keep legacy restore/trust semantics and show in doctor as
pending migration; re-run `oas migrate` when the official package publishes.
Approvals never carry over — re-trust after migrating.

### Upgrading a 0.18 deployment (bundled official capabilities → packages)

```
oas migrate --official --recursive --dry-run --dir <team-root>   # plan every scope
oas migrate --official --recursive --dir <team-root>             # apply, scope by scope
```

Guided mode for existing users. It plans every visible lock-owning scope first
(ancestor chain incl. outer/laptop locks, team boundary, pruned descendants;
path order, ancestors first), then applies each scope transactionally.

- Which package supplies a legacy capability is CATALOG data: identity by
  default, plus aliases (`oas.review` → package `oas.dev`). Never a hardcoded
  URL or tag, and no ref is guessed from the v1 capability version.
- Config files are never rewritten — exported ids are unchanged, so activation,
  layers, targets, settings and exclusions stay valid.
- No mapping yet at a scope → that scope is HELD and left untouched (nonzero
  exit, `--dry-run` included); legacy capabilities keep working. Nothing is
  converted to residue prematurely.
- `git:`/`path:`/unknown and owned capabilities are untouched; plain
  `oas migrate` is still the way to convert custom sources.
- After it runs: `oas trust <capability> --dir <scope>` for each executable
  surface it names (approvals never transfer), then `oas install --dir <scope>`
  — already-installed host requirements verify, nothing is reinstalled.
- `--json` emits one envelope; an aggregate failure is `ok:false` with
  `error.code = E_MIGRATE_FAILED` and the complete per-scope report (including
  the scopes that DID migrate) under `error.details`.

`oas doctor` detects the upgradeable state and prints the exact command
(`officialMigration` in `--json`), or says migration is not available yet while
confirming the legacy capabilities remain supported.

## Troubleshooting

`oas doctor [dir] [--json]` distinguishes: missing locked package (run
`oas install`), integrity drift (reacquire/update explicitly — approvals are
already invalid), capability-list mismatch, untrusted executable surface
(`oas trust <capability>`), legacy lock needing `oas migrate`, and migration
residue (JSON: `migrationResidue[]`, each with the exact retry action).

Source of truth beyond this skill: `oas --help` output,
`docs/oas-package.schema.json`, `docs/oas-lock.schema.json`, and
`docs/design/package-engine-contract.md` (+ `package-runtime-api.md`) in the
framework repo; `docs/capabilities.md` for the user-level walkthrough.
