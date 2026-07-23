---
type: Lesson
title: Pin node --test globs in repos that contain sibling worktrees
description: In OAS repos where agent instance homes contain nested work checkouts, bare node --test can recurse into stale sibling suites, so npm test must pin intended globs and destructive helpers must default to sandbox targets.
tags: [testing, node-test, worktree, tmux, oas]
timestamp: 2026-07-23
---

# Pin node --test globs in repos that contain sibling worktrees

OAS instance homes live under `agents/*/instances/*/`, and each instance can have a `work/` git worktree containing a full copy of the repo, including `test/`. In that layout, a bare `node --test` with no glob restriction recurses through nested checkout trees. Running `npm test` from one checkout can therefore execute stale test files from sibling instance worktrees.

This bit the repo when stale sibling copies of `test/capabilities.test.mjs` ran under `npm test`: their unanchored tmux retire helper matched live `reviewer-*` windows and killed them. The fix observed on main `0753b40` (feature branch `feature/desktop-app` at `df9fb69`) pinned `package.json` to explicit test globs:

```json
"test": "node --test 'test/**/*.test.mjs' 'tests/**/*.test.mjs' 'capabilities/**/*.test.mjs' 'packages/**/*.test.mjs'"
```

Destructive test helpers need their own guard as well. Tests that exercise retire set `PI_AGENTS_TMUX_SESSION: "oas-test-nosuch"` so even an accidentally executed stale copy cannot target the live tmux session.

# Practice

- Before running `npm test` on a branch in a repo that can nest agent worktrees or other checkouts, make sure the branch includes the pinned test globs.
- Treat unexpectedly high test counts as possible nested-suite inflation; the honest per-tree count observed after pinning was about 130.
- Any test helper that can kill tmux panes, processes, or files should anchor itself to an explicit sandbox target by environment instead of defaulting to a live target.
