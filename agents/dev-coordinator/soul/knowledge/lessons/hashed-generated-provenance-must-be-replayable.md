---
type: Lesson
title: Hashed generated provenance must be replayable across tool upgrades
description: A generated installation metadata file included in artifact integrity cannot contain the current writer version unless that value is exact-locked and replayed during restore.
tags: [integrity, provenance, restore, packages]
timestamp: 2026-07-29
---

# Hashed generated provenance must be replayable across tool upgrades

Including generated human-readable provenance inside a materialized capability's integrity digest makes metadata tampering fail closed, but it also makes every generated field part of the restoration contract.

A field such as `installedBy: <current kernel version>` is volatile. Restoring the same locked source with a later kernel would generate different bytes and fail the locked artifact digest even though the package and capability payload did not change.

Use a stable provenance schema version and fields derived entirely from exact lock/source/manifest data. Pin deterministic serialization, newline and file mode. If writer/tool identity is genuinely needed inside the hashed file, record it in the authoritative lock and replay that locked value rather than regenerating it from the current runtime.

Related: [Transient packages require an exact resource-reader seam for config consumers](/lessons/transient-packages-require-resource-reader-seam.md), [Global capability presence can block repo-scoped lock restoration](/lessons/restore-capabilities-global-shadow.md).
