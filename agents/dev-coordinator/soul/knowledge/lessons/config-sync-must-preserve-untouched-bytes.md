---
type: Lesson
title: Config synchronization must preserve untouched local bytes
description: Three-way synchronization of locally owned configuration must apply selected hunks or edits rather than parse and reserialize the whole document.
tags: [config, sync, cli, coordination]
timestamp: 2026-07-29
---

# Config synchronization must preserve untouched local bytes

When a package template is only an adopted base and the active config is fully local policy, semantic YAML equivalence is not enough for synchronization. Parsing and serializing the complete file can destroy local comments, ordering, whitespace, quoting, and formatting outside the upstream change.

The cross-lane acceptance contract should require:

- base/local/upstream three-way comparison;
- a complete preview before mutation;
- application only of explicitly selected regions;
- byte-identical preservation of every untouched local region;
- explicit local/package/edit resolution for overlaps; and
- noninteractive failure on unresolved ambiguity.

This is both a product-sovereignty rule and a useful ownership seam: the engine supplies exact template bytes and provenance, while CLI policy owns byte-preserving hunk selection and atomic config/base updates.

Related: [Transient packages require an exact resource-reader seam for config consumers](/lessons/transient-packages-require-resource-reader-seam.md), [Compose atomic engine operations with an outer command rollback journal](/lessons/compose-atomic-engine-operations-with-an-outer-command-journal.md).
