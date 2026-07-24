---
type: Lesson
title: Root test discovery requires dependency installation for private nested packages
description: When a root test command discovers tests inside a private nested package that is not an npm workspace, CI must install that package's lockfile as well as the root lockfile.
tags: [ci, testing, npm, monorepo]
timestamp: 2026-07-24
---

# Root test discovery requires dependency installation for private nested packages

A root test glob can make a private nested package part of the repository gate even when npm does not treat that package as a workspace. In that shape, root `npm ci` installs only the root dependency graph; tests imported from the nested package then fail on its undeclared-at-root runtime and dev dependencies.

The CI workflow must install every independently locked package whose tests the root command discovers (for example, `npm ci --prefix packages/<private-package>`), and cache keys should include that package's lockfile. A local green gate produced from a previously populated nested `node_modules/` does not verify clean-runner correctness.

# Related

- [Bare `node --test` recurses into agent worktrees — runs stale sibling test suites](/lessons/bare-node-test-recurses-into-agent-worktrees.md)
- [Scratch-worktree PR gates need dependencies and installed capabilities](/lessons/scratch-worktree-pr-gate-environment.md)
