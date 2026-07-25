---
type: Lesson
title: Global capability presence can block repo-scoped lock restoration
description: Bare oas install can incorrectly treat a global capability artifact as satisfying a different repo-scoped lock for the same capability ID.
tags:
  - capabilities
  - install
  - integrity
  - scope
---

# Global capability presence can block repo-scoped lock restoration

`restoreCapabilities(startDir)` walks each lockfile in the configuration chain, but checks presence with `capabilityManifest(id, startDir)`. That lookup spans the whole chain. A global artifact with the same capability ID can therefore make a repo-scoped lock report `present`, even when the repo-local artifact is missing and the global artifact has different integrity.

Observed while refreshing `oas.okf` after v0.18.2:

- repo lock required `oas.okf@1.4.0` with integrity `sha256-45c0cab49915fff18d97826bffb1cd0e4151e2930637744f707205dea4bc1499`;
- the existing repo-local store was stale, and `oas doctor` rejected it;
- after removing only the generated repo-local artifact, bare `oas install` reported the global `~/.agents/.../oas-okf` as `ok` instead of restoring the repo-local lock;
- `oas doctor` still failed because the global artifact's integrity differed from the repo lock.

The safe recovery was to call the normal `acquireCapability()` primitive directly for the repo scope with `expectIntegrity` set to the committed repo lock value. It reacquired the marketplace artifact into `~/oas/.agents/capabilities/installed/oas-okf`, verified exact integrity, and then `oas doctor . --json` passed.

A durable fix should make restore presence checks scope-specific: each lock level should be satisfied only by the artifact in that level's installed store, not by a same-ID artifact inherited from another configuration level.
