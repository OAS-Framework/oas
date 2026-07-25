---
type: Lesson
title: Git worktree rollback checks need retained canonical exact records
description: Git canonicalizes symlinked worktree paths, so rollback checks must capture the work realpath immediately after add, retain it through hooks and compensation, and compare exact NUL-delimited worktree records.
tags: [git, worktree, symlink, rollback, verification, hooks]
timestamp: 2026-07-25
---

# Lesson

reviewer-00f769e found this in worktree rollback verification (fixed in
89125ee): a worktree created through a symlinked agents/deployment root is
registered by Git under the canonical real path. A rollback check that asks
whether raw porcelain output includes the lexical `<symlink>/.../work` path can
miss the still-registered canonical path, letting `rmSync(home)` erase files
while stale Git worktree metadata remains.

reviewer-89125ee later found this pattern was still too late if
canonicalization waited until rollback (fixed in 07a973e): compensation retire
hooks can run first and remove or make `work/` inaccessible. `realpath(work)`
then fails, and falling back to the lexical path is inconclusive through a
symlinked deployment root while Git can still list a stale canonical
registration.

Correct pattern:

1. Immediately after `git worktree add` succeeds, capture `realpath(work)` and
   retain it in operation state. If that canonicalization itself fails,
   compensate the just-added worktree and branch before throwing.
2. Carry the retained canonical path through setup, hooks, launch, and
   compensation. Do not reconstruct it after arbitrary lifecycle code has run.
3. Probe with argv-based `git worktree list --porcelain -z`.
4. Parse exact NUL-delimited fields beginning with `worktree ` and compare each
   recorded path exactly to the retained canonical path. Never substring-match
   human or line-oriented porcelain.
5. Treat a failed list probe, or a missing retained identity, as "could not
   verify", not "absent"; rollback verification must fail closed.

This is the Git worktree version of the
[argv-safe, fail-closed rollback probe rule](/lessons/rollback-probes-argv-and-fail-closed.md).
Regression coverage should create the worktree through a symlinked agents root,
have a compensation retire hook remove or make `work/` inaccessible, force
`git worktree remove` and prune cleanup to fail through a delegating fake Git
wrapper while `worktree list` still returns the stale canonical record, and
assert rollback reports the retained canonical path rather than claiming
success; keep the fixture alongside the other
[test conventions](/playbooks/test-conventions.md).
