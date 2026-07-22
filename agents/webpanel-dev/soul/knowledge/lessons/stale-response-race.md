---
type: Lesson
title: Stale async paints need generation tokens, selection pinning, and context invalidation
description: Async fetch-then-paint paths such as chat, session, and Jira must combine request-generation tickets with selection/context checks, because identity-only guards pass when the same instance name recurs across workspaces and older responses land late.
tags: [oas-web, race-condition, chatReq, polling, workspace, gotcha]
timestamp: 2026-07-22
---

# The bug

The chat view polls every 1.5s (plus a 400ms fast loop after sends). Each
poll is an async fetch, and responses return **out of order** — a slow
response for instance A could land after switching to instance B, or after a
newer poll had already painted. Whichever response arrived last painted the
pane; with several busy sessions the view visibly ping-ponged between
transcripts.

A later review found the same class of residual race in `refreshJira`: its
stale guard was `s.sel !== name`, which checks identity only. With the same
instance name in two workspaces, the sequence "fetch Jira in wsB → switch to
wsA → reselect the same name → wsB's deferred response lands" passes the
name check and paints wsB's data into the wsA view.

# The fix — generation plus selection/context guards

1. **Request generations**: every async fetch-then-paint path keeps a
   generation counter (`chatReq` for chat); each fetch takes a ticket before
   the await and discards itself on arrival if its ticket is no longer
   current.
2. **Selection and context pinning**: the selected instance and relevant
   context are captured at fetch start and re-checked on arrival. Name checks
   alone cannot distinguish "same selection" from "same-named selection in a
   different workspace".
3. **Invalidation on every switch/clear**: selecting a different instance,
   clearing the selection, or switching workspaces must bump the generation
   counter so in-flight responses cannot paint. Switching also clears
   instance-local caches such as `lastChatSig` and `pendingSends`, so
   optimistic local state cannot re-render another session's content. The
   change-detection signature is also namespaced by instance.

# Regression pattern

Use manually resolved promises so the test controls response order: fire
request B, switch context, fire request A, resolve A, then resolve B late and
assert B's payload never overwrote A's. The state helper under test must
receive everything it dereferences — for the Jira race this included `s.ctx`
— or the test fails on `TypeError` instead of proving the race guard.

# General lesson

Any polled or async multi-target view in the panel (chat, session, Jira)
needs generation tickets, selection/context pinning, and cache/state
isolation. Generations alone do not cover optimistic local state, and
selection pinning alone does not cover two in-flight requests for the same
name across different contexts. Verification should control response order
and prove each pane stays locked to its own transcript or payload with zero
cross-bleed.
