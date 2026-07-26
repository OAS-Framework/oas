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
activation unit) and optional config profiles. Acquiring a package activates
NOTHING — activation stays in `oas-config.yaml` (see the oas-config skill).
Never hand-edit `oas-lock.json` or the stores; every operation below is a CLI
command, and all of them take `--json` (one stdout envelope, stable error
codes) and `--dir <scope>`.

## Sources

```
oas install git:github.com/org/repo@v1.0.0    # git shorthand (ref optional; resolved once, exact-locked)
oas install https://host/org/repo.git@v1.0.0  # raw HTTPS/SSH git URL
oas install ../my-package                     # local path (dev escape hatch)
oas install oas.okf                           # official catalog short id (identity only — no auto-trust)
```

Dependencies declared in `oas-package.json` must be pinnable (official
selector, tag/commit, or path). The whole closure is exact-locked in the
scope's `oas-lock.json` (`lockfileVersion: 2`): source, exact commit, tree
integrity, exported capabilities, dependencies, per-capability approvals.
Installed roots live in `<scope>/.agents/packages/installed/` (gitignored).

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

Executable surfaces (commands/hooks) are blocked until approved at the
provider package's EXACT integrity:

```
oas trust <capability>                     # approve only that capability
oas trust <package> --all-capabilities     # explicit bulk; prints the full executable surface first
```

Any integrity change (update, drift) invalidates every approval — re-review,
then re-trust. Skill/instruction/config-only capabilities need lock integrity
but no approval. Official-catalog identity is NOT executable trust.

## Runtime dependencies

A package (root or per-capability dir) may check in `package.json` +
`package-lock.json`; OAS materializes it with
`npm ci --omit=dev --omit=peer --ignore-scripts` — production tree only, no
lifecycle scripts. The source hash excludes `node_modules`, but the
materialized closure is hashed SEPARATELY as the lock's `depsIntegrity` and
verified by trust and restore — tampering materialized deps invalidates
approvals like source drift. Closures must be platform-invariant in v1.
Host peer APIs are reached only through the supported runtime
boundary, never auto-installed.

## Migration from v1 locks

```
oas migrate --dry-run          # plan: which v1 capability locks map to packages
oas migrate                    # atomic: converts mappable entries, retains the rest
                               # as residue in the v2 lock; rolls back on failure
```

Residue entries keep legacy restore/trust semantics and show in doctor as
pending migration; re-run `oas migrate` when the official package publishes.
Approvals never carry over — re-trust after migrating.

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
