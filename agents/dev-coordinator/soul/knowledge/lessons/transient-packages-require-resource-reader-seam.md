---
type: Lesson
title: Transient packages require an exact resource-reader seam for config consumers
description: When distribution package roots stop persisting, config adoption and synchronization need an engine API that returns exact locked template bytes and provenance without leaking staging paths.
tags: [coordination, packages, config-templates, interfaces]
timestamp: 2026-07-29
---

# Transient packages require an exact resource-reader seam for config consumers

Splitting a transient package engine from config-template CLI policy requires more than preserving `acquirePackage` and `listInstalledPackages`. Once staging is discarded, a config lane cannot reopen a persisted package directory to adopt or synchronize a template.

Freeze two data paths before parallel work:

1. acquisition returns validated template descriptors and bytes needed for same-transaction first adoption; and
2. later diff/sync/adopt operations call an exact locked-resource reader that re-stages the locked source and returns template bytes plus package/template/source/version/commit/path/integrity provenance.

The reader must not expose a temporary directory to the consumer. Otherwise staging lifetime leaks into the CLI contract and either causes use-after-cleanup bugs or recreates the persistent package-store architecture that the feature removed.

Related: [Config synchronization must preserve untouched local bytes](/lessons/config-sync-must-preserve-untouched-bytes.md), [Hashed generated provenance must be replayable across tool upgrades](/lessons/hashed-generated-provenance-must-be-replayable.md).
