---
type: Lesson
title: Guard async render completions on both success and error paths
description: Async renderer selections must mint a fresh generation for every user action and check one ownership predicate on both success and error completions, or stale rejections can overwrite a newer render.
tags: [oas-web, desktop, brain, renderer, race-condition, generation-token, testing, review-lesson]
timestamp: 2026-07-23
---

# The bug

Brain's selection race showed two ways a request-generation guard can be
weakened without looking obviously wrong:

- `sel.change` called `load(name, gen)` with the current generation, so two
  different selections shared one token and the older request still appeared to
  own the render.
- The success path checked both selection and generation, but the catch path
  checked only generation, so a stale request's late rejection could paint its
  error over a newer selection's rendered brain.

# Durable pattern

Use the diff renderer's `owns()` shape as the house pattern for async view
renders:

1. Mint a **new** generation for every user action before dispatching work.
2. Define one ownership predicate that captures the generation, mounted-ness,
   and selected name for that dispatch.
3. Check that same predicate before **every** completion-side mutation: success
   renders, error renders, status writes, and cleanup that affects shared view
   state.
4. Treat selection-only and generation-only checks as incomplete. A generation
   token works only if each action receives a fresh token, and errors are just
   as capable of stale UI writes as successful responses.

# Regression pattern

Control response order with manually resolved promises. Start two overlapping
selection loads, resolve the newer load first, then complete the older load late
in both modes: stale success after newer render and stale rejection after newer
render. The newer render must survive both completions. Before trusting the
coverage, mutation-check the test by reverting the guard shape or generation
minting and confirm the test fails.

# Related

- [Agent brain endpoint and desktop brain view](/architecture/agent-brain-endpoint-and-view.md) records the Brain renderer contract this race affected.
- [Race-guard tests must overlap generations and fail when the guard is weakened](/lessons/race-guard-tests-overlap-generations.md) covers the broader request-generation test shape.
- [Release async UI locks only on owned completion paths](/lessons/release-ui-locks-every-exit-path.md) applies the same owned-completion rule to disabled controls and lock release.
- [Split request generations by independently superseding request kind](/lessons/split-generation-counters-per-request-kind.md) covers Brain's roster-refresh versus selection-load counter split.
- [Workspace-sensitive async results need local tickets and global workspace generations](/lessons/stale-response-race.md) covers workspace-scoped async stale-result guards.
