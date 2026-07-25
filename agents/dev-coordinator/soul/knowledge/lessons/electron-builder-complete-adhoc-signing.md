---
type: Lesson
title: Electron linker signatures are not complete ad-hoc app-bundle signatures
description: A macOS Electron executable can report an ad-hoc linker signature while the app bundle lacks sealed resources and fails Gatekeeper as damaged.
tags:
  - desktop
  - macos
  - codesign
  - electron-builder
---

# Electron linker signatures are not complete ad-hoc app-bundle signatures

The official OAS Desktop v0.18.2 arm64 DMG had a valid published checksum and the correct arm64 executable, but macOS reported the app as damaged. The bundle was not simply unsigned:

- `codesign -dvvv` reported `Signature=adhoc` and `flags=adhoc,linker-signed`;
- `Sealed Resources=none`;
- `Contents/_CodeSignature/CodeResources` was absent;
- `codesign --verify --deep --strict` failed with `code has no resources but signature indicates they must be present`.

The executable's linker-generated signature was therefore not evidence that the Electron app bundle had been completely signed. In electron-builder 26.15.3, `mac.identity: null` disables app-bundle signing, while `mac.identity: "-"` selects deterministic ad-hoc signing without keychain lookup or credentials. With `identity: "-"`, both arm64 and x64 release artifacts passed strict deep verification and contained `Sealed Resources version=2`.

A macOS packaging gate should verify the packaged `.app`, not merely inspect the main executable:

```bash
codesign --verify --deep --strict --verbose=2 "OAS Desktop.app"
```

For stronger diagnosis, also require `_CodeSignature/CodeResources`, inspect signature details, and reject `linker-signed` as the only signature. Run the check after packaging and before artifact upload. This catches both the malformed v0.18.2 arm64 class and a completely unsigned bundle.

A complete ad-hoc signature fixes the false **“app is damaged”** failure, but it does not establish Apple trust or malware scanning. Gatekeeper can still show the separate **“Apple could not verify it is free of malware”** warning for a correctly ad-hoc-signed app. Users can authorize a verified artifact with Finder **Open** / Privacy & Security **Open Anyway**, or remove its quarantine attribute after verifying the official checksum and strict signature. Eliminating that warning for normal double-click distribution requires an Apple Developer Program Developer ID Application certificate, Apple notarization, and a stapled notarization ticket; ad-hoc signing alone cannot do it.
