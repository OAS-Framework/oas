---
type: Decision
title: Package-engine seam teardown keeps one resolver truth
description: After the package engine lands, WS2 package CLI code must route resolver semantics to engine exports, keep only WS2 policy helpers, and preserve engine lock and integrity errors instead of wrapping them as prose.
tags: [packages, package-engine, seam, teardown]
timestamp: 2026-07-26
---

# Decision

Maintainer gate 2 requires the post-WS1 package reconciliation to leave exactly
one resolver truth. After WS1's amended head merges, no WS2 code in
`lib/packages.mjs` may act as a second package resolver or swallow invalid lock
conditions such as `legacy-lock` or `integrity-drift` into prose.

This continues the seam-alignment posture in
[frozen package engine contract alignment](/lessons/frozen-package-engine-contract-alignment.md):
once the engine owns a behavior, WS2 should import or re-export it rather than
carry a parallel implementation.

# Replace with engine exports

Delete the WS2 bodies for these resolver/store semantics and route them to the
engine API:

- `loadPackageManifest`, `packageCapabilityIds`, and
  `packageCapabilityManifest` become schema-driven engine manifest validation.
- `readPackageLocksAt` / `readPackageLocks` become engine `readPackageLocks`;
  the envelope already matches `{ packages, legacy }`.
- `writePackageLock` becomes the engine version, including legacy-lock refusal.
- `resolvePackageClosure` and `acquirePackage` become engine `acquirePackage`,
  which adds git/catalog sources and transactional store+lock replacement.
- `restorePackages` becomes the engine version, including git/catalog restore.
- `resolvePackageSource` becomes engine `parsePackageSource` plus store/lock
  lookup; the git-clone-for-profile-read path should fold into acquisition or a
  read-only engine helper.
- `packageIntegrity` becomes the engine tree-hash export; verify that its walk
  semantics are identical to the current `capabilityIntegrity` alias at merge.
- `installedPackageDir`, `packageSlug`, and `installedPackagesDir` become
  engine store-path exports.

# Keep as WS2 policy

These helpers may stay in WS2 because they are profile, workspace, requirement,
or thin-reporting policy rather than resolver truth:

- Profile machinery: `selectProfile`, `readProfileText`, `validateProfile`,
  `profileProvenanceHeader`, `parseProfileProvenance`, and `diffConfigTexts`.
- Workspace discovery: `discoverWorkspaceScopes` and `PRUNED_DIR_NAMES`.
- Requirements: `normalizeRequirement`, `requirementInstallPlan`,
  `REQUIREMENT_MANAGERS`, `safeRequirementCommand`,
  `aggregateMissingRequirements`, `runRequirementInstall`, and `commandOnPath`.
- `lockedPackageCapabilities`, as thin composition over engine
  `readPackageLocks`.

# CLI and tests at teardown

Check these call sites when deleting the seam:

- `bin/oas.mjs` `dependencyClosureCapabilities` should use the engine lock
  graph. Dependencies are recorded by identity, so drop source-string parsing.
- `initPackage`'s acquisition branch should call engine `acquirePackage` for
  all source kinds, not only local sources.
- `packageLockReport` stays as the CLI mapping from engine `restorePackages` to
  reconciliation items.
- Error codes already align; keep engine `legacy-lock` and `integrity-drift`
  errors intact instead of catching and converting them to prose.
- `installFixturePackage` should stop writing test locks directly and use
  engine `acquirePackage` calls. Keep the `oas.dev` fixture shapes centralized
  in `oasDevFixture` for alignment with the amended engine head and WS3 plan.
