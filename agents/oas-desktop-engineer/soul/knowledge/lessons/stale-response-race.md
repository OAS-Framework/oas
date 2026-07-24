---
type: Lesson
title: Workspace-sensitive async results need local tickets and global workspace generations
description: Every async result that depends on the selected workspace — roster/agent refreshes, Jira fetches, and spawn completions — must capture a global workspace generation as well as any per-path request ticket, because same-named instances and workspace switches can let stale paints or terminal-opening actions land in the wrong workspace.
tags: [desktop-backend, race-condition, chatReq, polling, workspace, generation-token, spawn, testing, gotcha]
timestamp: 2026-07-23
---

# The bug

The chat view polls every 1.5s (plus a 400ms fast loop after sends). Each
poll is an async fetch, and responses return **out of order** — a slow
response for instance A could land after switching to instance B, or after a
newer poll had already painted. Whichever response arrived last painted the
pane; with several busy sessions the view visibly ping-ponged between
transcripts.

Later reviews found the same class in workspace-sensitive sibling paths:

- `refreshJira` guarded only with `s.sel !== name`, so the sequence "fetch
  Jira in wsB → switch to wsA → reselect the same name → wsB's deferred
  response lands" passed the identity check and painted wsB's data in wsA.
- Roster and agent refreshes such as `/api/agents` and `/api/panel` could land
  after a workspace switch and repaint the new workspace with the old
  workspace's data.
- Spawn completion is an async **action**, not just a paint: a spawn begun in
  workspace A that completes after switching to workspace B must not call
  `ctx.openTerminal(name)`, because terminal opening resolves the instance name
  in the current workspace and a same-named B instance could receive input
  meant for the new A instance.

# The fix — request tickets plus workspace generation guards

1. **Per-path request generations**: repeated async fetch-then-paint paths keep
   a local counter (`chatReq` for chat); each fetch takes a ticket before the
   await and discards itself on arrival if its ticket is no longer current.
2. **Global workspace generation**: any async result whose meaning depends on
   the selected workspace captures `workspaceGeneration()` at dispatch and
   compares it after each await. Keep the counter module-level in `common.mjs`
   and bump it inside `setWorkspace()` itself so every workspace switch
   invalidates all dependent paths at once; this is safer than per-view
   listeners that individual paths can forget to subscribe to.
3. **Selection and context pinning**: the selected instance and relevant
   context are captured at fetch start and re-checked on arrival. Name checks
   alone cannot distinguish "same selection" from "same-named selection in a
   different workspace".
4. **Action degradation on mismatch**: stale paints should be discarded; stale
   spawn completions should degrade to a status message such as "spawned in the
   previous workspace — switch back to open" rather than auto-opening a
   terminal in the current workspace. Even when the workspace is still current,
   post-spawn terminal opens must first wait for the workspace-scoped panel
   roster to include the instance; see [Wait for the roster snapshot before
   post-spawn instance actions](/lessons/post-spawn-roster-snapshot-lag.md).
5. **Cache invalidation**: selecting a different instance, clearing the
   selection, or switching workspaces must also clear instance-local caches
   such as `lastChatSig` and `pendingSends`, so optimistic local state cannot
   re-render another session's content. The change-detection signature is also
   namespaced by instance.

# Regression pattern

Use manually resolved promises so the test controls response order: fire
request B, switch context, fire request A, resolve A, then resolve B late and
assert B's payload never overwrote A's. The state helper under test must
receive everything it dereferences — for the Jira race this included `s.ctx`
— or the test fails on `TypeError` instead of proving the race guard.

For workspace generation regressions, capture-and-release promise gates let
the test switch workspaces between dispatch and completion deterministically.
View functions that render need a stub `globalThis.document` with
`createElement` and cleanup afterward; prefer assertions on state such as
`s.souls` over DOM details. For spawn, include both the switch-race case and a
no-switch control that proves auto-open still works when the generation has
not changed. For UI request-generation guards, keep the two generations truly
overlapping and mutation-check that removing the generation comparison fails;
see [Race-guard tests must overlap generations and fail when the guard is weakened](/lessons/race-guard-tests-overlap-generations.md). When a parent refresh replaces a child control's options, split the request generations by request kind and disable the stale control while the parent refresh is in flight; see [Split request generations by independently superseding request kind](/lessons/split-generation-counters-per-request-kind.md).

# General lesson

Any polled or async multi-target result in the panel (chat, session, Jira,
rosters, agents, spawn completion) needs the right combination of local
request tickets, global workspace generation capture, selection/context
pinning, and cache/state isolation. Local generations alone do not cover
sibling paths or action completions; selection pinning alone does not cover
two in-flight requests for the same name across different workspaces; and
optimistic local state needs its own isolation. Verification should control
response order and prove each pane or action stays locked to its dispatch
workspace with zero cross-bleed.
