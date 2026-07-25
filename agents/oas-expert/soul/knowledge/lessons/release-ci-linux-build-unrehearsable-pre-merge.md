---
type: Lesson
title: Tag-driven release CI hides a CI-only Linux build failure the maintainer gate cannot rehearse
description: A green PR gate plus a sound-looking release.yml is not proof the release will publish; the exact Linux/mac installer build only runs on a real on-main tag, so a packaging-config defect (e.g. AppImage executableName from a scoped package name) surfaces only after merge+tag, with nothing published.
tags: [release, ci, desktop, electron-builder, mergeability, pull-requests]
timestamp: 2026-07-24
---

# Tag-driven release CI hides a CI-only Linux build failure the maintainer gate cannot rehearse

When the release is tag-driven and the workflow only triggers on a `vX.Y.Z`
tag that must be reachable from `main`, the exact installer-build matrix
(macOS DMG/ZIP, Linux AppImage/DEB) **cannot be rehearsed before merge** —
there is no on-main tag until you merge. If operator policy also forbids
local cross-platform builds, the maintainer's local gate (`npm test`,
`check`, `validate`, `pack:check`, `smoke:tarball`, a static
`release-workflow.test.mjs` seam test) proves the code and the workflow
*logic* but never actually runs `npm run dist` on Linux. A packaging-config
defect therefore survives an exhaustive review chain and a full local gate,
then fails the real release run **after** merge+tag, with npm and the GitHub
Release never publishing (`publish` needs the desktop matrix green).

Concrete instance (v0.18.1): `electron-builder.config.cjs` set `productName`
and `appId` but no `executableName`. On Linux, electron-builder derives the
executable name from the package.json `name`, which was scoped
(`@oas-framework/desktop` → `@oas-frameworkdesktop`), and the AppImage target
rejects it: *"executableName contains characters that cannot be safely used
in file paths."* macOS DMG/ZIP has no such constraint, so a local mac-only
`npm run dist` verification passed and hid it. Matrix fail-fast then
**cancelled** the mac legs, so their status was unproven, and `publish` was
skipped — nothing shipped.

Maintainer takeaways:
- A "sound exact-tag rehearsal" claim is only real if a Linux+mac installer
  build has actually gone green on the tagged tree. Two prior failed release
  runs for the same version line are a strong signal the installer path has
  never succeeded — check release run history before trusting the rehearsal.
- For scoped Electron packages, require an explicit filesystem-safe
  `executableName` (e.g. `oas-desktop`) in the builder config; the scoped
  npm name is not a valid Linux executable name.
- Prefer a release matrix WITHOUT `fail-fast` so one leg's failure does not
  mask the others; you want to see every platform's real outcome in one run.
- The merge itself is not wrong to keep: the app code, security boundaries,
  and tests were sound; the defect was packaging config only. Recovery is a
  small config fix landed on main plus a re-cut. Because nothing published,
  the version number is retag-safe, but retagging vs. bumping the patch is a
  human decision, and the fix belongs to the electron-builder owner, not the
  maintainer.
- Structural gap worth proposing: give the desktop package a Linux
  installer-build check (or a `workflow_dispatch` release rehearsal off a
  branch) so the AppImage/DEB path is exercised BEFORE the on-main release
  tag, closing the pre-merge rehearsal hole.
