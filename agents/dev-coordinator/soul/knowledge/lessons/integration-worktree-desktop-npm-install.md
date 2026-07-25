---
type: Lesson
title: Integration worktrees need root and package npm installs before gates
description: Fresh integration worktrees need dependency installs in each package that owns a gate: missing root dependencies can break `npm run validate`, and missing `packages/desktop` dependencies can make desktop tests fail en masse with ERR_MODULE_NOT_FOUND.
tags: [integration, desktop, testing, worktree]
---

# Integration worktrees need root and package npm installs before gates

When integrating desktop work in a temporary worktree (`git worktree add /tmp/...`), missing dependencies can look like real feature regressions. Install dependencies in the worktree areas whose gates you are about to run:

- Root gates: run `npm install` at the worktree root before `npm run validate` or other root scripts. During keybindings integration, `npm run validate` needed root dependencies because the validator imports `ajv`.
- Desktop package gates: run `cd packages/desktop && npm install` before desktop tests. A fresh worktree without `packages/desktop/node_modules` failed 10 files with `Cannot find package 'jsdom'`.

Distinguish these dependency misses from real feature failures before pinging developers.

Also observed (2026-07-25): `test/desktop-server.test.mjs` "mutation without a CLI adapter degrades" (expects 503, gets 409) fails on clean origin/main — pre-existing, not feature work.
