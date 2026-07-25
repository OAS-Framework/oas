---
type: Lesson
title: Git worktree rollback checks need canonical exact records
description: Git canonicalizes symlinked worktree paths, so rollback checks must capture the work realpath before removal and compare it to exact NUL-delimited worktree records.
tags: [git, worktree, symlink, rollback, verification]
timestamp: 2026-07-25
---

# Lesson

reviewer-00f769e found this in worktree rollback verification (fixed in
89125ee): a worktree created through a symlinked agents/deployment root is
registered by Git under the canonical real path. A rollback check that asks
whether raw porcelain output includes the lexical `<symlink>/.../work` path can
miss the still-registered canonical path, letting `rmSync(home)` erase files
while stale Git worktree metadata remains.

Correct pattern:

1. Capture `realpath(work)` before attempting removal; after failure and home
   deletion, the canonical path may no longer resolve.
2. Probe with argv-based `git worktree list --porcelain -z`.
3. Parse exact NUL-delimited fields beginning with `worktree ` and compare each
   recorded path exactly to the captured canonical path. Never substring-match
   human or line-oriented porcelain.
4. Treat a failed list probe as "could not verify", not "absent"; rollback
   verification must fail closed.

This is the Git worktree version of the
[argv-safe, fail-closed rollback probe rule](/lessons/rollback-probes-argv-and-fail-closed.md).
Regression coverage should create the worktree through a symlinked agents root,
force `git worktree remove` to fail through a delegating fake Git wrapper, and
assert rollback reports the canonical registered path rather than claiming
success; keep the fixture alongside the other
[test conventions](/playbooks/test-conventions.md).
