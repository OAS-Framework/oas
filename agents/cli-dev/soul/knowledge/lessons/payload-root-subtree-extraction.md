---
type: Lesson
title: Package payload extraction bugs live between clone and installed artifact
description: Fetch clones beside the destination and renames only the selected payload subtree in, resolving containment on real paths so symlink escapes and broken links fail closed before store or lock writes.
tags: [packages, kernel, containment, security]
timestamp: 2026-07-28
---

`fetchPackageSource` used to clone straight into `dest`, so the installed
artifact and the repository were the same directory. Once a package payload can
be a contained root, the clone and the installed artifact differ, and the
correctness bugs live in that gap.

# Extraction shape

Clone into `${dest}.checkout` beside `dest`, resolve the selected payload,
`renameSync(payload, dest)`, and remove the checkout in a `finally`. Same-parent
staging keeps the move on one filesystem, and `renameSync` avoids the cost and
metadata surprises of copying.

Drop `.git` from the installed artifact. Otherwise a root selection ships clone
metadata while a subtree selection does not, and "installed bytes equal the
selected subtree" stops being true for exactly the canonical `#.` case.
`packageIntegrity` already ignored `.git`, so this changes disk contents rather
than hashes.

# Containment outcomes

Decide containment on real paths, not lexical paths, and keep three outcomes
separate:

1. **Absent**: the path names nothing. This is an inspection diagnosis and an
   acquisition failure.
2. **Present but dangling**: `existsSync` is false while `lstatSync` succeeds.
   This is a broken symlink and must fail closed as `path-escape`, not be
   treated as absent.
3. **Escaping**: `realpathSync` lands outside `realpath(checkout)`, which is
   `path-escape`.

A contained symlink is followed like any other directory; renaming its target out
of a checkout that will be deleted is fine.

# Inspection and fallback consequences

`inspectGitSourceRoot` reports two layouts: payload fields
(`payloadDir`/`payloadPackage`/`payloadCapability`) for package acquisition, and
repository-root fields (`dir`/`package`/`capability`) for the legacy standalone
capability fallback. Keeping the root fields under their original names let
`acquireCapability` remain untouched.

The legacy standalone-capability fallback must fire only when no path was
explicitly selected and the repository root has no `oas-package.json`. Without
that guard, a root-flat package (`oas-package.json` and `oas.json` side by side)
that is no longer found by the new default silently downgrades to capability
acquisition. The useful user-facing outcome is the pointed package error telling
the operator to select the root explicitly with `#.`.

See [the payload-root contract](/decisions/package-payload-root-contract.md) for
source and lock semantics, and [fetch seam sharing](/lessons/fetch-seams-share-resolver.md)
for the second fetcher this exposed.
