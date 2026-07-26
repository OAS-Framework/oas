---
type: Lesson
title: Wait for terminal readiness before post-spawn terminal handoffs
description: /api/panel can show a freshly spawned instance before its tmux window is ready, so post-spawn terminal auto-open must poll the workspace-scoped panel for running plus tmux.session and degrade quietly.
tags: [desktop-backend, desktop-app, spawn, snapshot, race-condition, workspace, tmux]
timestamp: 2026-07-26
---

# The bug

Post-spawn terminal handoffs race the panel snapshot in two ways:

1. Immediately after `POST /api/spawn` succeeds, the selected workspace's
   `/api/panel` may not yet contain the spawned instance because `/api/panel` is
   served from the background roster snapshot rather than the spawn result.
2. Once `instance.json` exists, the snapshot may include the row before the tmux
   window registers. A presence-only wait can then see `running: false` or a
   missing `tmux.session` and hand off to `openTerminalTabInner`, whose open path
   refuses with the blocking "no live tmux session" alert.

Leaving the spawn modal open on success compounds the race: an alert over an
open modal reads like a stuck modal rather than a slow readiness handoff.

# Fix pattern

Any post-spawn terminal auto-open should poll the selected workspace's
`/api/panel` until the spawned instance satisfies the same readiness predicate
that the terminal-open path requires: the instance exists, `!!running`, and
`!!tmux?.session`. Predicate parity keeps the auto-open wait from racing the
open-path refusal.

The wait loop still needs the same ownership guards as the spawn action: each
iteration checks the current operation/workspace predicate before continuing or
opening the terminal. If a newer operation supersedes the spawn, or the selected
workspace changes while waiting, abort the auto-open.

On readiness, close the spawn modal before handing off and open the terminal in a
quiet mode so automated handoffs route refusals through diagnostics rather than
`alert()`. Quiet handoffs must also contain the whole async open promise chain;
see [Quiet automated opens must contain the whole flow's rejections](/lessons/quiet-open-whole-flow-rejection-containment.md).
If readiness times out, degrade to the existing status that tells the operator to
open the instance from the sidebar roster, with the modal still open.

# Test fallout

Tests that drive the spawn flow must answer the post-spawn `/api/panel` polls
with rows that satisfy the full readiness predicate when the wait is expected to
succeed: `running: true` and `tmux: { session: ... }`, not just a matching name.
This applies to both `packages/desktop/test` fixtures and the repo-root
`tests/desktop-views.test.mjs` suites that exercise `doSpawn`.

A successful spawn now closes the modal. Multi-leg modal tests must reopen the
modal and re-query controls after each successful spawn instead of reusing stale
handles from the previous modal instance.

# Related concepts

- [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md)
- [Keep roster collection out of the serving process](/lessons/snapshot-collection-off-thread.md)
- [Workspace-sensitive async results need local tickets and global workspace generations](/lessons/stale-response-race.md)
- [Shared-form async actions need operation ownership tokens](/lessons/shared-form-operation-token.md)
- [Release async UI locks only on owned completion paths](/lessons/release-ui-locks-every-exit-path.md)
- [Quiet automated opens must contain the whole flow's rejections](/lessons/quiet-open-whole-flow-rejection-containment.md)
