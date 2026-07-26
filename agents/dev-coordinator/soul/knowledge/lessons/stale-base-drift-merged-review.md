---
type: Lesson
title: Merged-state reviewers catch stale-base drift against moving main
description: A feature branch cut early can silently regress freshly-shipped main work; check origin/main movement before each review round, and route behavioral merge conflicts to the owning developer.
tags: [integration, review, git, coordination]
---

# Merged-state reviewers catch stale-base drift against moving main

During the split-panels feature, `origin/main` moved after `feature/split-panels` was cut when PR #40 (quick-open) landed. The coordinator's gate runs were green, but the diff from current `origin/main` to the feature branch would have removed shipped features; only the merged-state reviewer's merge-tree check against current `origin/main` caught the drift.

Takeaways:

- Before spawning each merged-state reviewer, and again before opening the PR, check whether `origin/main` advanced since the feature base. If it did, reconcile first and re-run the gate; a green gate on a stale base tests the wrong product.
- Behavioral merge conflicts belong to the developer who owns the feature logic. The coordinator can handle trivial or union-style conflicts, such as append-only knowledge `log.md` entries, but should route conflicts in developer-owned code back to that developer with the conflict map.
