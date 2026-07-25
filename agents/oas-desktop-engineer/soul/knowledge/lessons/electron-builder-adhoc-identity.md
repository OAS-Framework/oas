---
type: Lesson
title: electron-builder identity "-" produces complete ad-hoc mac bundle signatures
description: Proven semantics of electron-builder mac.identity values — null disables signing entirely and can ship linker-signed partial ad-hoc defects; "-" ad-hoc signs the full bundle including nested helpers/frameworks with sealed resources.
tags: [desktop, packaging, electron-builder, codesign, macos]
timestamp: 2026-07-25
---

# electron-builder identity "-" produces complete ad-hoc mac bundle signatures

These semantics were proven on electron-builder 26.15.3 (`app-builder-lib`), not
assumed:

- `mac.identity: null` calls `helper.handleNullIdentity()` and skips signing
  entirely. On the v0.18.2 arm64 installer, the Electron executable kept only
  its linker-generated partial ad-hoc signature (`flags=adhoc,linker-signed`,
  `Sealed Resources=none`, no `Contents/_CodeSignature`), failing
  `codesign --verify --deep --strict` with "code has no resources but signature
  indicates they must be present" and making Gatekeeper report the app as
  damaged. The x64 cross-build executable had no signature at all.
- `mac.identity: "-"` is special-cased by `findSigningIdentity` when
  `qualifier === "-"` (`MacTargetHelper.js`): it constructs an ad-hoc
  `Identity("-")` without keychain lookup, so it works with
  `CSC_IDENTITY_AUTO_DISCOVERY=false` and no certificates. `@electron/osx-sign`
  then signs every nested helper/framework and seals resources. Both arm64 and
  x64 outputs passed `codesign --verify --deep --strict --verbose=2` in local
  verification.
- The default hardened runtime stays on (`flags=adhoc,runtime`).
  electron-builder's default entitlements template includes
  `com.apple.security.cs.disable-library-validation`, which ad-hoc signing plus
  hardened runtime requires; electron-builder warns about this, but the default
  template already satisfies it.
- `builder_util.isPullRequest()` checks `GITHUB_BASE_REF` and skips signing on
  PR builds unless `CSC_FOR_PULL_REQUEST=true`. A PR-triggered
  `build-installers` run needs that environment variable or the mac bundles
  come out unsigned and the codesign gate fails.
- Ordering matters: the `afterPack` hook runs before signing, so afterPack
  mutations such as spawn-helper chmod land inside sealed resources. Do not
  mutate the bundle after signing.

For the strict verification shape that caught the defect, see [Strict deep
codesign gates need structural bundle-seal pre-checks](/lessons/macos-strict-codesign-gate-structure.md).
