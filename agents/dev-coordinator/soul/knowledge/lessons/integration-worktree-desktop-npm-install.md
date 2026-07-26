---
type: Lesson
title: Integration worktrees need packages/desktop npm install before the gate
description: A fresh git worktree of the oas repo shares root node_modules via the checkout but packages/desktop has its own node_modules; without `npm install` there, the desktop test suite fails en masse with ERR_MODULE_NOT_FOUND (jsdom etc.), which looks like real regressions.
tags: [integration, desktop, testing, worktree]
---

# Integration worktrees need packages/desktop npm install before the gate

When integrating desktop work in a temp worktree (`git worktree add /tmp/...`),
`npm test` initially failed 10 files — all `Cannot find package 'jsdom'`.
Cause: `packages/desktop` is a private package with its own `node_modules`,
not hoisted to root; a fresh worktree has none. Fix: `cd packages/desktop &&
npm install` inside the worktree, then re-run the gate. Distinguish this from
real failures before pinging developers.

Also observed (2026-07-25): `test/desktop-server.test.mjs` "mutation without a
CLI adapter degrades" (expects 503, gets 409) fails on clean origin/main —
pre-existing, not feature work.
