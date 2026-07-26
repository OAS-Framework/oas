---
type: Lesson
title: Review the whole PR merge range for scope, not only the intended feature files
description: A feature PR can accidentally carry unrelated local or stewardship commits that are not on GitHub main, so maintainers must inspect the actual merge range before running expensive gates.
tags: [pr-review, mergeability, stewardship]
timestamp: 2026-07-26
---

# Lesson

During PR #44, the body described a `packages/desktop` split/sidebar/tab-strip UI feature, but the actual merge range from GitHub `main` also contained dev-coordinator soul skill/lesson changes, ux-designer log changes, and oas-expert architecture/decision/roadmap/stewardship updates.

The important maintainer check is the **whole merge range** (`origin/main...HEAD`, or GitHub's changed-files/commits view), not the author's intended feature area. If local direct/stewardship commits exist on a developer's branch but are not on GitHub `main`, a seemingly focused feature PR can silently become the vehicle for unrelated decisions or skill changes.

# Practice

At the product-direction gate, compare the PR description with the full changed-file list and commit range before running expensive correctness/security gates. If unrelated base commits appear, return the PR for branch rebuilding or for those base commits to land through their own proper maintainer path first.
