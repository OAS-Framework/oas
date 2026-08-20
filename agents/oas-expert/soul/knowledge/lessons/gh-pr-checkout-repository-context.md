---
type: Lesson
title: GitHub PR checkout uses the current repository even with an explicit remote repo
description: Run gh pr checkout with an explicit repository from the intended target clone because the repository flag selects the PR source but does not relocate the checkout operation.
---

# GitHub PR checkout uses the current repository even with an explicit remote repo

`gh pr checkout <number> --repo owner/name` can fetch the named repository's PR commit into whichever Git checkout is the current working directory and switch that current checkout to the foreign commit. The `--repo` option identifies the GitHub PR; it does not select a local target clone.

For cross-repository maintainer review, create the scratch clone first and run the checkout with that clone as the process working directory (or use `git -C <scratch> fetch ...` plus a detached checkout). Immediately verify both the shared checkout branch and the scratch `HEAD` before continuing.

Related scratch-gate environment setup is covered by [Scratch-worktree PR gates need dependencies and installed capabilities](/lessons/scratch-worktree-pr-gate-environment.md).
