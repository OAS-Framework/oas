---
type: Lesson
title: Legacy resource spelling is not a safe package-format discriminator
description: Optional legacy fields cannot reliably distinguish old packages from new ones when immutable old packages may omit that resource entirely.
tags: [packages, compatibility, manifests, migration]
timestamp: 2026-07-29
---

# Legacy resource spelling is not a safe package-format discriminator

Using the presence of deprecated `configs` to identify a legacy package and permit a `capabilities: ["."]` root looked convenient, but an immutable published package (`oas.authoring@1.0.0`) uses `.` and has no config resource at all. The optional spelling therefore cannot identify its format.

When no explicit format version exists, compatibility reading and new authoring validation are separate contracts:

- readers must continue accepting historical shapes independently of unrelated optional resources; and
- authoring tools/validators must reject emitting deprecated shapes.

A new canonical field can unambiguously signal the new format when present, but absence of both old and new optional fields cannot prove that a package is newly authored.

Related: [Replace unadopted transitional formats in place instead of versioning compatibility](/lessons/replace-unadopted-transitional-formats-in-place.md).
