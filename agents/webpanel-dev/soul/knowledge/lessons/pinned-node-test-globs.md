---
type: Lesson
title: Pin node --test globs when agent worktrees are siblings
description: Never run bare node --test from an OAS repo that hosts agents/*/instances/*/work siblings; use npm test so explicit globs avoid stale sibling-worktree suites and destructive old tests.
tags: [testing, worktree, tmux, safety, oas-web]
timestamp: 2026-07-22
---

# Pin node --test globs when agent worktrees are siblings

An OAS deployment can place sibling worktrees under `agents/*/instances/*/work` inside the repo. A bare `node --test` with no globs recurses into those worktrees and runs stale copies of test files instead of only the current tree's suite.

# Failure mode observed

The unpinned runner inflated test counts and executed stale destructive tests. One stale `capabilities.test.mjs` still had an unanchored tmux retire assertion and killed live `reviewer-*` windows.

# Durable rule

Do not run bare `node --test` from a repo that hosts agent worktrees. Use `npm test`, which pins explicit globs (`'test/**' 'tests/**' 'capabilities/**' 'packages/**'`) and carries the `PI_AGENTS_TMUX_SESSION` defense.
