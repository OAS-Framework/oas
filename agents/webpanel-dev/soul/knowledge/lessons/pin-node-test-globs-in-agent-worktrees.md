---
type: Lesson
title: Pin node --test globs in agent worktrees
description: In OAS agent worktrees, bare `node --test` can recurse into sibling `agents/*/instances/*/work` trees and run stale or destructive copied tests, so npm test must pin explicit repository-owned test globs.
tags: [testing, safety, worktree, tmux, node-test]
timestamp: 2026-07-23
---

# Failure mode

The OAS repository hosts agent worktrees under `agents/*/instances/*/work`.
Running bare `node --test` without explicit globs from an agent worktree can
recurse into those sibling worktrees and execute stale copies of the suite from
other branches.

The observed third path in the reviewer-death saga was an older sibling copy of
`capabilities.test.mjs` whose unanchored tmux retire killed live `reviewer-*`
windows, even though the current tree's copy had already been fixed.

# Rule

`npm test` must pin explicit test globs to the repository's own trees instead
of relying on node's recursive discovery. The fix that landed on main in
`0753b40` pins globs for `test/**`, `tests/**`, `capabilities/**`, and
`packages/**` `*.test.mjs`, plus adds a `PI_AGENTS_TMUX_SESSION` defense.

Before running `npm test` in a shared-workspace worktree, make sure that fix is
present. Treat lower post-fix test counts as honest per-tree numbers: previous
higher counts could be inflated by sibling-worktree suites, not real coverage.
