---
type: Decision
title: A capability's provider package is resolved at the capability's own lock level
description: Merged lock maps resolve packages and capabilities independently, so provider package lookup for a capability row must use the row's own lock file instead of the closest package identity.
tags: [oas-kernel, locks, provenance, trust, nested-scopes]
timestamp: 2026-07-29
---

# The shape of the bug

`readPackageLocks` merges every visible lock from outermost to innermost, with
closest wins per identity, independently for packages and capabilities. That is
right for "which capability is active here" and wrong for "which package
provides this capability row".

Example:

| scope | package | exports |
|---|---|---|
| outer | `x.p@1` | `x.b` |
| inner | `x.p@2` | `x.a` |

`locks.capabilities["x.b"]` is the outer capability row (`_file` = outer lock),
but `locks.packages["x.p"]` is the inner package row. A consumer doing
`locks.packages[row.package]` therefore pairs `x.b` with a package from a scope
that never exported it, producing wrong version/commit in `list` and `doctor`
and wrong provenance in `verifyCapabilityInstallation`.

# The rule

`providerPackageRow(locks, row)` resolves the provider inside `row._file`.
`readPackageLocks` also returns per-level data:

```js
levels: [{ level, file, packages, capabilities }]
```

The strict parser already refuses a capability whose provider is missing from
the same file's `packages` map, so a row that survived reading can be resolved at
its own level.

At the CLI, `levelRows(locks, level)` applies the same rule for `list` and
`trust`.

# Consequences

1. `listInstalledPackages` cannot be keyed by package id alone. The inner entry
   overwrote the outer entry, making outer-scope capabilities vanish from
   `list` and `doctor` while still locked and materialized. Key by
   `level \0 id` to keep both rows. The array stays outermost to innermost, so
   callers resolving an identity take the last match to preserve closest wins.
2. `oas trust <pkg> --all-capabilities` must not filter the merged capability
   map by `row.package === id` across every level and then write all rows into
   one target lock. A package identity resolves to exactly one scope — the
   closest scope that locks it — and only that scope's capability rows are the
   command's to approve.

# Why it stayed hidden

Fixtures never locked one package id at two levels. Nested scopes are normal in
a team workspace, and version skew between an outer workspace pin and an inner
repo pin is an ordinary case.

See also [final package lifecycle transaction invariants](/lessons/final-package-lifecycle-transaction-invariants.md) for the own-scope mutation rule and [init lock visibility package twin](/lessons/init-lock-visibility-package-twin.md) for another place where lock-chain visibility needs level awareness.
