---
type: Lesson
title: Split request generations by independently superseding request kind
description: Do not let a child selection request share the same generation token as the roster refresh that populates it; each request kind gets its own counter, and a parent refresh may cancel child loads but child loads must not cancel the parent refresh.
tags: [oas-web, desktop, brain, roster, race-condition, generation-token, testing, review-lesson]
timestamp: 2026-07-23
---

# The race

Brain's roster refresh (`loadAgents()`) and per-selection brain fetch (`load()`) once shared one generation counter. After a workspace switch started `/api/agents`, the stale selector was still enabled; changing that stale selector bumped the shared counter, so the in-flight roster response failed its own generation check and the old workspace's agents stayed stranded in the new workspace.

# Durable pattern

1. Give each independently superseding request kind its **own** generation counter. A roster refresh and a per-selection fetch do not supersede each other symmetrically, so they must not share one token.
2. Let parent refreshes retire child work when they replace the child's input set: bump the per-selection generation when the roster is about to be replaced.
3. Do not let child work retire the parent refresh. A selection change may cancel older selection fetches, but it must not invalidate the roster request that will repopulate the selector.
4. Disable a control while an async refresh is replacing its contents, so stale interactions cannot race the refresh with old options.

# Regression shape

Hold `/api/agents` during a workspace switch, fire a change event on the still-stale selector, then resolve the roster. The new roster must populate and the selector must be re-enabled. The test fails if `loadAgents()` and `load()` share one generation token or if stale selector interactions remain possible while the roster refresh is in flight.

# Related

- [Guard async render completions on both success and error paths](/lessons/guard-both-completion-paths.md) covers the per-selection Brain load guard.
- [Workspace-sensitive async results need local tickets and global workspace generations](/lessons/stale-response-race.md) covers workspace-level invalidation and per-path request tickets.
