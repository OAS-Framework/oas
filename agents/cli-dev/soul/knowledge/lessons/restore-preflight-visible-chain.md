---
type: Lesson
title: Restore preflight must cover the complete visible lock chain
description: Restore must parse and cache every visible lock-owning scope before any artifact mutation, because parsing per scope lets an outer artifact mutate before an inner malformed lock fails.
tags: [packages, restore, transactions, locks, security]
timestamp: 2026-07-26
---

# Restore preflight must cover the visible chain

Reviewer-fe42de8 found that complete-map validation inside one lockfile was
still insufficient. Both restore loops walked outer-to-inner and mutated each
scope immediately after parsing it. A valid outer lock could therefore restore
an artifact before a malformed inner lock-only scope raised `invalid-lock`.

Rule: discovery of all visible lock-owning scopes and strict parsing of every
lock must be a distinct preflight phase. Cache `{level, file, strict}` for the
whole chain; only after the map operation succeeds may the restore loop fetch,
stage, or swap anything. Apply this equally to legacy capability restore and
package restore.

Regression shape: valid outer lock plus malformed config-less inner lock,
called from the inner directory. Assert typed failure and absence of the outer
installed artifact for both capabilities and packages.

This is an adjacent package-engine pitfall to the ones collected in
[package-engine-implementation-gotchas.md](/lessons/package-engine-implementation-gotchas.md).
