---
type: Lesson
title: Consumed-once pending intents must gate on data currency and owner lifetime
description: A consumed-once intent that applies to async workspace data must check intent/data generations before clearing, die with the mounted consumer, and reveal the resolved target if filters hide it.
tags: [desktop, spawn, quick-open, lifecycle, races, generation-tokens]
timestamp: 2026-07-26
---

# The race

Quick Open's Spawn handoff used a module-level `pendingPreselect` that should be consumed once by the Spawn roster. A review of commit `6d5e183` found that `applyPreselect` cleared the pending intent before matching, and `preselectSoul` applied immediately whenever `s.souls.agents.length` was truthy.

During a workspace switch, `s.souls` can still hold the previous workspace's agents while the new refresh is pending. Treating "some roster is loaded" as sufficient can consume the preselect against stale data: at worst it matches a same-named wrong soul, and at best it silently loses the preselect before the current workspace roster paints.

# Fix pattern

For a pending intent that resolves against async workspace data:

1. Stamp the data with the generation under which it was fetched, such as `s.rosterGen = myGen` at the paint commit.
2. Stamp the pending intent with the generation under which it was minted.
3. On consumption, first require the intent generation to equal the current workspace generation. If it does not, drop the intent because it predates a switch.
4. Then require the data generation to equal the current workspace generation. If it does not, defer without clearing the intent; the current refresh can apply it after painting.
5. Only clear the consumed-once intent after the generation checks prove it is being applied to current data.

This extends [split request generations by independently superseding request kind](/lessons/split-generation-counters-per-request-kind.md): presence of data is not the same as currency of data when workspace switches can overlap a refresh.

# Deferred intents must die with their consumer

The same Quick Open preselect used a module-level `pendingPreselect`. After the stale-roster fix began deferring until the roster generation became current, `unmount()` still only killed the view state. A deferred intent could survive navigation away from Spawn and be consumed by a later remount in the same workspace generation, popping a modal minutes after the user's intent expired.

Generation gates protect against wrong data, not against a dead consumer. Any pending intent parked at module scope while waiting for data currency must be bound to the lifetime of the owner that will consume it: clear it in that owner's teardown, or carry a mount token and discard when the owner dies. For Spawn preselects, `unmount()` clears `pendingPreselect`.

Regression shape: defer with a hanging roster, unmount Spawn, release the roster, remount Spawn in the same workspace generation, and assert no modal. Mutation-check by removing only the unmount clear; the test must fail.

# Reveal intents must reveal the target

The same review found that the degraded/attached fallback focused a card by searching only rendered cards. If an active view filter excluded the target, a consumed preselect became a silent no-op even though the soul existed.

When an intent resolves to "reveal X in a view", the resolver must make X visible before focusing it. For Spawn preselects, if the target soul exists but its card is absent from the rendered list, clear the filter and repaint before focusing the card.

# Regression shape

- Hang the new workspace's roster fetch, switch workspaces, and preselect while the stale roster is still present. Use the same soul name in both rosters with different work modes so stale consumption would visibly misbehave.
- Cover attached or degraded souls hidden by an active filter; applying the preselect should clear the filter/repaint and then focus the target card.

# Related

- [Quick Open hands off to Spawn via a consumed-once preselect](/decisions/quick-open-spawn-preselect-handoff.md)
- [Workspace-sensitive async results need local tickets and global workspace generations](/lessons/stale-response-race.md)
- [Split request generations by independently superseding request kind](/lessons/split-generation-counters-per-request-kind.md)
