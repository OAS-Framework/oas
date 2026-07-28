---
type: Lesson
title: A lock field that is turned back into a spec must be parsed as strictly as the spec
description: parseLockSource accepted any payload after a known scheme, so catalog:../evil validated and updatePackage re-parsed it as a host-relative local path and acquired from the operator's filesystem.
tags: [packages, kernel, lock-v2, security, review]
timestamp: 2026-07-28
---

`parseLockSource` split on the scheme prefix and returned whatever followed:
`catalog:<anything>` produced `{kind: "catalog", id: <anything>}`. Every
consumer that only READS the lock was fine with that — `validateLockEntry` merely
asserted `src.id` was truthy.

The hole is in the one consumer that WRITES a spec back out. `updatePackage`
re-derives an acquisition spec from `entry.source`, so `catalog:../evil` became
the spec `../evil`, which `parsePackageSource` classifies as a **local path**
resolved against the process CWD. A hand-edited or attacker-supplied lock turned
an official-catalog entry into an acquisition from the operator's filesystem — a
kind change, not just a bad value.

# The rule

**A persisted field that is later re-parsed as input must be validated against
the exact grammar its writer produces, not against its prefix.** Round-tripping
is the security boundary: read-only validation strictness is not enough when some
code path converts the value back into a command.

Concretely, `parseLockSource` now enforces: catalog ids match the package-id
regex with a non-empty selector when `@` is present; path sources are absolute;
git sources are a real http(s)/ssh/file/git URL with a non-empty ref when `@` is
present; and no source carries a `#<path>` fragment (that would also produce a
double-fragment spec on update now that the selected root is its own field).

# Two neighbours of the same shape

- **`defaultCatalogResolve` dropped the entry's `path`.** The feature worked
  perfectly in every test because tests inject their own catalog resolver; only
  the PRODUCTION resolver was lossy. Test a data-driven contract through its real
  reader (`OAS_PACKAGE_CATALOG`), not only through the injection seam, or the
  seam is all you have verified.
- **"Absent" and "present but malformed" must not collapse.** Returning
  `undefined` for a `null` input let a catalog entry spelling `"path": null`
  silently install the default root. `undefined` means absent; anything else
  present is a violation.

See [package payload root contract](/decisions/package-payload-root-contract.md)
and [fetch seam sharing](/lessons/fetch-seams-share-resolver.md).
