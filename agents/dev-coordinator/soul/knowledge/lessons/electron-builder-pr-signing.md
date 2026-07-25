---
type: Lesson
title: electron-builder skips macOS signing in pull-request CI unless explicitly enabled
description: Pull-request installer rehearsals need CSC_FOR_PULL_REQUEST=true or electron-builder can skip even deterministic ad-hoc signing and invalidate release evidence.
tags:
  - desktop
  - ci
  - macos
  - electron-builder
---

# electron-builder skips macOS signing in pull-request CI unless explicitly enabled

A build-only pull-request workflow can fail to rehearse the real macOS release path even when the electron-builder configuration requests ad-hoc signing. electron-builder detects pull-request environments through variables such as `GITHUB_BASE_REF` and skips Mac signing unless `CSC_FOR_PULL_REQUEST=true` is set.

For OAS's credential-free ad-hoc signing contract, the build-only installer workflow needed:

```yaml
env:
  CSC_IDENTITY_AUTO_DISCOVERY: "false"
  CSC_FOR_PULL_REQUEST: "true"
```

This is safe in this specific contract because:

- the identity is the deterministic ad-hoc `"-"` identity;
- no signing certificate or notarization secrets exist;
- certificate auto-discovery is disabled;
- the pull-request workflow has read-only contents permission and no publication surface.

This flag is dangerous to copy blindly into credentialed signing workflows: enabling signing on untrusted fork PRs can expose certificate-backed operations or secrets. It should be paired with an explicit no-secrets posture and tests that preserve that posture.

The release tag workflow does not need the flag because it is not a pull-request run. Both workflows should nevertheless run the same strict packaged-app verification before artifact upload so rehearsal evidence predicts release behavior.
