---
type: Lesson
title: Quiet automated opens must contain the whole flow's rejections
description: A quiet fire-and-forget open path must wrap the entire async flow, not only explicit refusal branches, so transport or mount failures become diagnostics instead of unhandled rejections.
tags: [desktop, async, error-handling, quiet-open, unhandled-rejection]
timestamp: 2026-07-26
---

# The bug

A reviewer caught that routing only the explicit `alert()` refusals in
`openTerminalTab(ref, { quiet })` through `notify` did not make the automated
open path quiet. Transport failures from the `/api/panel` fetch, or mount
failures inside `openTerminalTabInner`, still escaped the async function.

That matters for post-spawn handoffs because the spawn flow closes the modal and
then calls `ctx.openTerminal(...)` fire-and-forget. Any rejection outside the
explicit refusal branches becomes an unhandled promise rejection instead of the
promised diagnostic warning.

# Fix pattern

Put the failure policy around the whole importable open flow, not around the
branches that are easy to see. For the desktop terminal handoff, the stable shape
is an importable helper such as `runOpenFlow(flow, { quiet, notify })`:

- in quiet mode, await `flow()` and catch every rejection into `notify`;
- in interactive mode, return the flow's promise untouched so the caller can
  surface failures in its normal blocking/UI path;
- keep shell wiring as a one-line composition-root binding, such as
  `return runOpenFlow(() => openTerminalTabFlow(ref, notify), { quiet, notify })`.

That helper belongs in an importable module so tests can assert behavior rather
than source strings: quiet opens do not reject and route errors to `notify`,
interactive opens still reject, and message-less rejections get a useful
fallback diagnostic.

# General lesson

A "no blocking UI from automated paths" guarantee covers the whole promise
chain, not only early-return branches that would otherwise call `alert()`. When a
caller intentionally fire-and-forgets an async UI handoff, the handoff must own a
complete rejection policy before it crosses the fire-and-forget boundary.

# Related concepts

- [Wait for terminal readiness before post-spawn terminal handoffs](/lessons/post-spawn-roster-snapshot-lag.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
- [Guard async render completions on both success and error paths](/lessons/guard-both-completion-paths.md)
