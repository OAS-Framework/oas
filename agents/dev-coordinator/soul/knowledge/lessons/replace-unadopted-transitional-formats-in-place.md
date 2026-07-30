---
type: Lesson
title: Replace unadopted transitional formats in place instead of versioning compatibility
description: When a transitional lock format has no required product adoption, reusing its version for the final contract can eliminate an entire reader and migration subsystem.
tags: [packages, locks, compatibility, coordination]
timestamp: 2026-07-29
---

# Replace unadopted transitional formats in place instead of versioning compatibility

A sequential implementation plan can mistake every already-coded format for a permanent compatibility obligation. If a transitional format has not become supported user state, assigning a new lock version to its replacement creates unnecessary dual readers, offline projection, trust carry-over rules, rollback fixtures, migration commands, and store cleanup logic.

Before freezing a new version, establish whether the predecessor is actually adopted product state. When it is not, replacing the transitional contract in place can be safer and substantially simpler:

- one current schema and writer;
- clear rejection of the abandoned transitional shape;
- no guessed conversion semantics; and
- compatibility retained only for genuinely supported historical deployments.

The coordinator must propagate such a ruling before either lane consumes the seam, then remove obsolete gates and briefs rather than carrying them as defensive complexity.

Related: [Legacy resource spelling is not a safe package-format discriminator](/lessons/legacy-format-spelling-is-not-a-safe-compatibility-discriminator.md).
