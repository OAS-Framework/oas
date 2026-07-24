---
type: Lesson
title: Wait for the roster snapshot before post-spawn instance actions
description: oas-web serves /api/panel from a background snapshot, so a successful spawn is not immediately resolvable by name; post-spawn actions such as opening a terminal must poll the workspace-scoped panel until the instance appears or degrade safely.
tags: [oas-web, desktop-app, spawn, snapshot, race-condition, workspace]
timestamp: 2026-07-23
---

# The bug

A spawn success path immediately called `ctx.openTerminal(instance)`. That
follow-up resolves the instance through `/api/panel`, but `/api/panel` is served
from the oas-web background roster snapshot. The snapshot refreshes roughly every
3 seconds, so the newly spawned instance can be absent immediately after
`POST /api/spawn` succeeds. In that steady state, the terminal open fails with
"unknown instance" even though the spawn itself succeeded.

# Fix pattern

Any post-spawn follow-up that resolves the instance by name should first wait for
the workspace-scoped panel roster to contain that name. Poll the selected
workspace's `/api/panel` until `instances[]` includes the spawned instance, then
hand off to the follow-up action.

The wait loop needs the same ownership guards as the spawn action: each iteration
checks the current operation/workspace predicate before continuing or opening the
terminal. If a newer operation supersedes the spawn, or the selected workspace
changes while waiting, abort the auto-open. If the roster never catches up,
degrade to a status such as "roster is catching up; open it from the Instances
view" instead of attempting a doomed open.

# Test fallout

Tests that drive the spawn flow must now answer the post-spawn `/api/panel`
polls. This includes sibling suites with fake APIs: after the spawn POST resolves,
the fake panel responses need to include the spawned instance or the wait loop can
hang. When a view acquires a new post-await dependency, grep all suites for
callers of that view and update their fakes.

# Related concepts

- [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md)
- [Keep roster collection out of the serving process](/lessons/snapshot-collection-off-thread.md)
- [Workspace-sensitive async results need local tickets and global workspace generations](/lessons/stale-response-race.md)
- [Shared-form async actions need operation ownership tokens](/lessons/shared-form-operation-token.md)
