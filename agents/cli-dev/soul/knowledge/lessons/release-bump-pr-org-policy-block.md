---
type: Lesson
title: Release bump PR can be blocked by GitHub org Actions policy
description: A release can publish npm and GitHub Release successfully while the final version-bump PR is blocked by org policy, so publication-first ordering keeps the release live and leaves only manual PR rescue.
tags: [release, ci, github-actions, org-policy, ordering]
timestamp: 2026-07-25
---

# Lesson

In the v0.18.3 release run `30156853485`, npm publication and GitHub Release creation succeeded, but the final housekeeping step — the automated version-bump PR back to protected `main` — was blocked by a GitHub organization policy restricting GitHub Actions from creating pull requests (`createPullRequest` denied to the workflow token). Recovery was manual rescue PR #28, which landed the root, `packages/pi`, and desktop manifest bumps.

This repeats the recovery shape from the [detached-HEAD refspec lesson](/lessons/exact-tag-detached-head-refspec.md): keep irreversible publication before fragile housekeeping. With that ordering, a post-publication workflow failure is cosmetic; the release is already live and only the bump PR needs rescue.

# Future hardening

The bump-PR step has another failure mode beyond detached-HEAD refspecs: org-level "Allow GitHub Actions to create and approve pull requests" settings. A future hardening could pre-check that permission or document the manual rescue path. In this failure shape, the branch push succeeds and only `gh pr create` fails; open the PR by hand from the pushed `release-bump/vX.Y.Z` branch.
