---
type: Lesson
title: Classify local-path policy before tilde or base-directory expansion
description: Path normalization can erase whether a manifest spelling was host-ambient; classify tilde/relative policy before expanding to an absolute path, or remote package metadata can bypass no-local-base guards and select host files.
tags: [security, packages, paths, normalization]
timestamp: 2026-07-26
---

# Path policy before normalization

Reviewer-3626ef2 found that `~/bait` and `path:~/bait` were expanded to an
absolute `$HOME` path before `relativeSpec` was calculated. A git/catalog
manifest could therefore pass the no-local-base guard and acquire ambient
host content. This is the same security class as the earlier `path:sub` CWD
bypass.

Rule: preserve the *spelling's policy class* before normalization. Tilde is
host-ambient and must retain `relative:true` for dependency-policy checks,
even though its final resolved path is absolute. Operator root sources may
still use tilde; only remote-manifest dependencies are forbidden.

Regression shape: put a valid bait package under `$HOME`, declare both raw
and `path:`-prefixed tilde forms from a git parent, assert coded failure,
whole-transaction rollback, and byte-identical lock; separately assert the
operator root tilde form still works.

# Related

This is a package-engine implementation gotcha; see
[package-engine implementation gotchas](/lessons/package-engine-implementation-gotchas.md).
