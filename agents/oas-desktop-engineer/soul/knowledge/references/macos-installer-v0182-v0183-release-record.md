---
type: Reference
title: v0.18.2 malformed installer defect and the v0.18.3 terminal release facts
description: Terminal record of the macos-correct-installers feature — the v0.18.2 linker-signed/unsigned mac installer defect, the identity "-" ad-hoc fix, the strict verification gates, and the verified v0.18.3 release outcome.
tags: [desktop, packaging, release, codesign, macos]
timestamp: 2026-07-25
---

# v0.18.2 malformed installer defect and the v0.18.3 terminal release facts

This is the terminal record for the `macos-correct-installers` feature.

## Defect

The official v0.18.2 arm64 DMG was operator-verified with a matching checksum.
`mac.identity: null` in electron-builder disabled signing entirely, so the
arm64 app executable retained only its linker-generated partial ad-hoc
signature (`flags=adhoc,linker-signed`, `Sealed Resources=none`, no
`Contents/_CodeSignature`). Strict deep verify failed with "code has no
resources but signature indicates they must be present", and Gatekeeper reported
the app as damaged. The x64 bundle was fully unsigned.

## Fix

The desktop slice at commit `c84ea14` for feature `macos-correct-installers`
changed the mac signing path to `mac.identity: "-"`: electron-builder's ad-hoc
special case that produces a complete bundle signature, signs nested
helpers/frameworks, seals resources, needs no keychain or secrets, and works
with `CSC_IDENTITY_AUTO_DISCOVERY=false`. The signing semantics are detailed in
[electron-builder identity "-" produces complete ad-hoc mac bundle signatures](/lessons/electron-builder-adhoc-identity.md).

The fix also added `scripts/codesign-verify.mjs` as a strict deep codesign gate
wired into dist-smoke as an unconditional darwin phase, with 15 unit tests
pinning argv and failure classes. `CSC_FOR_PULL_REQUEST=true` was added in
`build-installers.yml` so PR builds actually sign. The gate structure is detailed
in [Strict deep codesign gates need structural bundle-seal pre-checks](/lessons/macos-strict-codesign-gate-structure.md).

Independent review by opus-4.8 was `APPROVE WITH NITS`, with no blockers.

## Terminal release

The release outcome was independently verified via `gh` and npm, not just
reported:

- PR #27, "fix: publish valid ad-hoc-signed macOS installers", merged as
  `921f44a`.
- Tag `v0.18.3` and release run `30156853485`.
- `build-and-test` and all three `desktop-build` legs were green. The strict
  codesign gate was enforced on both mac legs.
- npm root and `pi` 0.18.3 were published.
- The GitHub release carried all six installers, `SHA256SUMS.txt`, and
  provenance.
- Public arm64 DMG re-download verified checksum OK, strict deep codesign valid,
  `Signature=adhoc`, and sealed resources v2 with 179 files.
- The only red step in the run was the post-publication version-bump PR, a
  maintainer-housekeeping path rather than the installer path.

v0.18.2 assets were never overwritten; contract clause 9 held.
