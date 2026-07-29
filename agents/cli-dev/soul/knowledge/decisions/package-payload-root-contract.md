---
type: Decision
title: Configurable package payload roots are selected explicitly per source kind
description: Git package roots are selected by a #<path> fragment, catalog roots by a catalog path field, local paths by their named directory, and locks keep the canonical path separate from source so updates and restores can preserve the right owner.
tags: [packages, kernel, lock-v2, acquisition]
timestamp: 2026-07-29
---

The package engine contract now treats a Git repository as a container that may
hold the package payload somewhere below the repository root. The selected
package root is explicit, not heuristic.

# Where the path lives

- **Git specs** carry the payload root as a `#<path>` fragment. Split the
  fragment off before `@ref` parsing; otherwise `repo@v1#dist` treats
  `v1#dist` as the ref. Only one fragment is valid.
- **Catalog entries** carry the payload root as data (`{ url, ref?, path? }`),
  not in the catalog id string. Allowing `#` on a catalog id would create two
  spellings for one selection and fight the catalog's ownership of package
  layout.
- **Local paths** take no fragment and always resolve to `.`. The named
  directory is the package root, whatever it is called; applying the Git default
  to local sources would break direct package development.
- The default is applied during resolution, not parse. Parsing records
  `packagePath: undefined` so a catalog entry can still supply one.

# Why `path` stays separate in the lock

The lock keeps the canonical payload path in a field separate from `source`.
`updatePackage` re-derives a spec from the locked `source`, and Git selections
and catalog selections need opposite round-trip behavior: a Git path is the
user's selection and must be re-appended as `#<path>` so it stays sticky, while a
catalog path belongs to the catalog and must be re-read so an update can adopt a
moved root.

The dependency-closure dedupe key is therefore `source#path`. Comparing only
`source` makes two contained roots in one repository look like the same package
resolved twice, silently dropping one instead of raising
`duplicate-package-identity`.

During `oas update`, that ownership difference becomes visible when an upstream
root is renamed:

- Git update rebuilds `<url>[@<ref>]#<locked path>` and fails `invalid-source` if
  the old path no longer exists. Re-acquiring with the new path is not the repair
  path because acquire refuses to advance a locked source as `integrity-drift`,
  and update still resolves the stale fragment; the operator must remove the
  package and then install the new `#<path>`.
- Catalog update rebuilds `<id>[@<selector>]`, re-reads the entry path, moves the
  lock to the new root, and reports `pathChanged` even if no bytes or version
  changed. The CLI prints the path-only movement as:

  ```text
  package path pkgs/x → packages/x (the selected package root MOVED in the source)
  ```

# Canonical path and lock advancement

Every spelling of the root (`""`, `"."`, `"./"`, `"./."`) normalizes to `"."`.
`validateLockEntry` requires the stored value to equal its own canonicalization;
a lock recording `"./sub"` is `invalid-lock`, not silently repaired on read.
Normalizing on read would make lock round trips untestable and would let two
byte-different locks claim the same pin.

Path changes are lock advancement. A plain `oas install` that resolves a
payload path different from the lock's `path` fails with `integrity-drift` before
integrity comparison, because two different roots can contain byte-identical
trees. The acquire-time path-mismatch diagnostic must branch on the **locked**
source kind because that is the source `oas update` re-resolves from: catalog
locks may recommend `oas update <pkg>` because the catalog entry owns `path`,
Git locks must not recommend update because the operator's `#<path>` fragment is
sticky across updates and must instead be repaired by remove-then-install with
the intended fragment, and local path locks always select `.` so this mismatch is
unreachable. See [diagnostic remedies are contracts](/lessons/diagnostic-remedies-are-contracts.md)
for the testing lesson.

Restore passes the locked path as an override that beats both the spec and the
catalog entry, so neither an upstream `git mv` nor a repointed catalog can change
what a bare restore installs. A bare restore is also pinned to the locked commit,
where the old root still exists, so an upstream move cannot break an existing
deployment.

# Test fixture facts

- `DEFAULT_PACKAGE_PATH` is `"oas-package"`; a bare Git source looks for
  `oas-package/oas-package.json`, and `#.` selects the repository root.
- `file://<dir>` is the network-free Git spelling. The `git:` shorthand demands
  `host/org/repo`, and a `path:` source forces `packagePath: "."` and rejects any
  `#<path>` fragment.
- On catalog update, `pathOverride` is undefined, so
  `pathOverride ?? entryPath ?? DEFAULT_PACKAGE_PATH` and
  `entryPath ?? pathOverride ?? DEFAULT_PACKAGE_PATH` are equivalent for that
  code path; a mutant swapping them can survive legitimately. Pair this fixture
  with the [CLI spawned-process hermeticity lesson](/lessons/cli-tests-scrub-oas-pi-env.md)
  when testing `test/cli-lifecycle.test.mjs` cases.

See [payload root subtree extraction](/lessons/payload-root-subtree-extraction.md)
for how acquisition cuts the selected bytes out of the clone.
