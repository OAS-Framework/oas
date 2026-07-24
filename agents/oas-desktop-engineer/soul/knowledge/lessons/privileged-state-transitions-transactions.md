---
type: Lesson
title: Privileged state transitions are transactions
description: Privileged desktop flows that mutate workspace state or server ownership must serialize requests, stage effects, verify readiness and currency, commit only after success, and restore previous state on failure.
tags: [desktop, transaction, async, child-process, race]
timestamp: 2026-07-24
---

When a desktop flow mutates durable workspace state or process ownership before
its outcome is known, treat the flow as a transaction rather than a callback
with a late generation check.

- **Generations guard reads, not writes.** `isCurrent()` can make a stale
  response inert, but it cannot undo writes that already happened. The
  workspace-add flow must serialize add requests, stage prospective
  `workspaceDirs` and recents, pass staged state to effects without committing
  it, verify readiness and currency, and only then commit. Any failure restores
  the previous state.
- **Child-process replacement is not atomic.** `kill()` only signals; wait for
  the old child to actually exit before spawning a successor that binds the
  same port, with a SIGKILL fallback timer for stuck exits. Exit listeners also
  must compare ownership before clearing globals: `if (currentChild === child)`.
  A late predecessor exit must not erase ownership of its replacement.
- **Readiness must verify identity, not just liveness.** During same-port races,
  any 2xx `/api/version` can come from the wrong process. Run the response
  through the desktop server compatibility check before trusting
  `/api/panel.workspaces` advertisement or committing the add. This extends the
  [server reuse identity probe](/lessons/server-reuse-identity-probe.md) rule and the
  [privileged workspace add contract](/decisions/desktop-workspace-add-privileged-contract.md).
- **Tests should pin the transaction boundary.** Extract the effectful sequence
  behind injectable dependencies, as `createAddExecutor` does in
  `packages/desktop/workspace-registry.mjs`, and mutation-check that
  commit-before-readiness, skip-identity, and drop-serialization variants fail.
  This follows the [regression test layer](/lessons/regression-tests-bug-layer.md)
  discipline.
