---
type: Lesson
title: Release async UI locks only on owned completion paths
description: Any lock or disabled control taken before an async operation must be released on every completion path, but only by the request that still owns that UI state.
tags: [desktop-backend, desktop, brain, race-condition, ui-lock, generation-token, review-lesson]
timestamp: 2026-07-23
---

# The bug

The Brain roster refresh disabled the agent selector while `/api/agents` was in
flight, but its catch path only painted the error. A transient roster failure
therefore left the selector permanently disabled.

# Durable pattern

A UI lock is shared state, just like rendered content or status text. When an
async operation disables a control or otherwise takes a lock, capture the
operation owner at dispatch and gate both paint and unlock through the same
ownership predicate. Release the lock on every current completion path:

- success,
- error, and
- empty-result or no-op completions.

The release must still be conditional. A stale completion must not unlock a
newer operation's lock, so checks like `myRoster === rosterGen` gate both stale
paint suppression and lock release. Treat an unconditional `finally` that
re-enables a shared control as suspect unless it first proves the completing
operation still owns the control.

# Regression shape

Cover both halves of the invariant with manually controlled promises:

1. Reject the **current** refresh and assert the selector re-enables while the
   error is painted.
2. Start one refresh, supersede it with a newer refresh that remains in flight,
   then reject the older refresh late. The selector must stay locked for the
   newer refresh, and the stale error must not paint.

# Related

- [Guard async render completions on both success and error paths](/lessons/guard-both-completion-paths.md) covers stale success/error paint guards for Brain selection loads.
- [Split request generations by independently superseding request kind](/lessons/split-generation-counters-per-request-kind.md) covers the Brain roster-refresh generation split that owns this selector lock.
- [Shared-form async actions need operation ownership tokens](/lessons/shared-form-operation-token.md) covers the same owner-token rule for shared form enablement and resets.
