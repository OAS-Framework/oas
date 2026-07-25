---
type: Lesson
title: Strict deep codesign gates need structural bundle-seal pre-checks
description: codesign --verify --deep --strict rejects the observed unsealed-bundle and unsigned-nested-component defects, but checking Contents/_CodeSignature/CodeResources first gives an exact failure for the linker-signed/unsealed v0.18.2 class.
tags: [desktop, packaging, codesign, verification, macos]
timestamp: 2026-07-25
---

# Strict deep codesign gates need structural bundle-seal pre-checks

When gating packaged macOS apps on signature validity (for example,
`scripts/codesign-verify.mjs`), `codesign --verify --deep --strict --verbose=2
<app>` correctly rejected both defect classes observed during the v0.18.3 fix:

- an unsealed bundle, seen in the v0.18.2 arm64 installer, with diagnostics like
  "code has no resources but signature indicates they must be present" and
  "invalid resource directory";
- an unsigned nested component, reproduced by removing a helper signature, with
  "code object is not signed at all" and an `In subcomponent: ...` detail.

Still pre-check `Contents/_CodeSignature/CodeResources` before running
`codesign`. It names the v0.18.2 defect class — a linker-signed executable in an
unsealed bundle — exactly in the failure message instead of depending only on
`codesign` phrasing, and it costs nothing.

After a passing verify, run `codesign --display --verbose=2` and use the output
as CI evidence: log `Signature=` and `Sealed Resources`, and reject output that
contains `linker-signed` as belt-and-braces against future `codesign` semantic
drift. `codesign` writes both verify diagnostics and display output to STDERR,
not stdout.

Fixture gotcha: deleting `_CodeSignature` from a properly signed bundle and
re-signing only the main executable non-deep reproduces the v0.18.2 failure
mode. `codesign --force --sign - <exe>` is file-level when pointed at the
executable path; pointing it at the `.app` regenerates a bundle seal. Build
broken fixtures by signing the executable path, not the bundle path.
