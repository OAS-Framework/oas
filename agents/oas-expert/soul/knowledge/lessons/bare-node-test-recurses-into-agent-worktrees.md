---
type: Lesson
title: Bare `node --test` recurses into agent worktrees — runs stale sibling test suites
description: Bare node --test with no path arguments walks the whole cwd tree except node_modules, including agents/*/instances/*/work checkouts; pin test scripts to explicit globs to avoid running stale sibling suites.
tags: [node-test, npm-test, worktrees, incident, reviewer-deaths]
timestamp: 2026-07-23
---

# Lesson: bare `node --test` runs sibling agent worktrees' tests

## Incident

A reviewer died even though both main and the reviewed worktree contained the
retire-path fix described in [tmux target prefix matching can kill foreign windows](/lessons/tmux-target-exact-matching.md).
The repo's `test` script was bare `node --test`, and Node's default test
discovery recurses the whole current working directory except `node_modules`.
In the OAS deployment root, `agents/*/instances/*/work` directories are real
checkouts of the same repo, so root `npm test` executed stale sibling copies of
`test/capabilities.test.mjs` as well as the intended suite.

Those stale copies predated the tmux exact-target fix. Their unanchored
`retireInstance(root, "reviewer-1", {})` calls hit the same prefix-matching
kill window and killed the live reviewer. The inflated earlier test count was
the same discovery-scope smell: 596 discovered tests instead of the true 65.

## Fix

- Pin the package `test` script to explicit globs such as
  `node --test 'test/**/*.test.mjs' 'tests/**/*.test.mjs' 'capabilities/**/*.test.mjs' 'packages/**/*.test.mjs'`.
- Keep the defense in depth for CLI subprocess spawn/retire tests: set
  `PI_AGENTS_TMUX_SESSION` to a nonexistent session so subprocess `oas retire`
  calls cannot target the real agent tmux session.

## General rules

- Never ship a bare `node --test` in a repo whose tree can contain nested
  checkouts, agent homes, worktrees, or fixtures; scope discovery explicitly.
- Treat a suspiciously large test count as a discovery-scope smell.
- Fixing code on main does not defuse stale copies in sibling worktrees if a
  root test command can still execute them; scope of execution matters as much
  as the fix itself.
