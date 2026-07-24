---
type: Lesson
title: Separate latest-intent ownership by operation class
description: "Asynchronous UI stays truthful when reads, modal lifetime, discovery, and side-effecting mutations have separate ownership tokens and mutations are single-flight."
tags:
  - async
  - concurrency
  - state-management
  - testing
timestamp: 2026-07-24T10:35:50Z
---

# Lesson

One global generation counter is often too coarse. A picker can legitimately run while suggestion discovery remains owned; incrementing a shared counter discards the discovery and can leave permanent loading text. Use separate generations for workspace/roster state, modal lifetime, discovery reads, and mutations.

# Rules

- Capture the ownership token before awaiting and check it on success and failure.
- A workspace change invalidates old workspace reads before they can paint or activate tabs.
- Closing a modal invalidates its discovery; opening a picker does not.
- Store discovery results that arrive behind a native picker and repaint them after cancellation.
- Side-effecting add/picker pipelines are single-flight: guard handlers and disable every alternate selection/submission path.
- Do not let dismissal hide a mutation whose side effect may still succeed; reconcile success exactly once.
- Treat stale/superseded domain outcomes as neutral rather than errors.

# Testing

Use deferred promises to force A→B→A completion orders. Attempt synthetic clicks and keyboard selection while busy, not only normal disabled-button clicks, to prove handler-level ownership.
