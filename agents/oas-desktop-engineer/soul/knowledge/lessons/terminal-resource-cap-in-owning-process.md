---
type: Lesson
title: Bounded OS resources spawned per user action need a hard cap in the owning process
description: Renderer-side tab dedupe is best-effort UX, not a resource bound; pty and tmux-viewer ceilings must be deduped and capped in the Electron main process that owns them.
tags: [desktop, terminal, tmux, resource-management, security, incident]
timestamp: 2026-07-24
---

Opening many agent terminals in one Desktop session once spawned one attached tmux
viewer session plus one `node-pty` process per `term:open` call until the
operator laptop hung. The root cause was not tmux itself: `term:open` created a
fresh `oasdesk-<pid>-*` viewer session and pty on every call, with no ceiling and
no reuse by target.

Renderer tab dedupe by `(ws, instance)` is only best-effort UX scoped to the
current workspace tab list. Reconnects, re-renders, stale async completions, IPC
bypass, or many distinct instances can still accumulate OS resources without a
bound.

# Rule

Any bounded OS resource created per user action must have its dedupe and ceiling
enforced in the process that owns the resource. For the desktop terminal path in
[Desktop terminal is a direct tmux attach via node-pty](/decisions/desktop-terminal-direct-attach.md),
that owner is the Electron main process: it owns the pty map and isolated tmux
viewer sessions, so it must reject or reuse `term:open` before creating more.
The renderer may dedupe tabs for convenience, but it cannot be the resource
bound.

A safe shape is a pure, synchronous registry around terminal creation:

- `plan(targetKey)` returns reuse, cap, or create without mutating. The caller
  creates the pty only for create, then commits the slot.
- Because the main-process IPC handler is synchronous end to end for terminal
  open, plan → create → commit is atomic on the single main thread; concurrent
  IPC opens cannot interleave to exceed the cap.
- IPC returns structured outcomes such as `{ id }`, `{ reused, id }`,
  `{ capped, active, max }`, or `{ error }`. Cap rejection should be visible and
  actionable (for example, "Close a terminal tab first"), not a silent eviction
  or extra create.
- `release()` runs on pty exit, tab close, and app quit so the slot is freed
  exactly once. If creation fails, commit nothing; partial viewer cleanup remains
  the opener's responsibility.

Tests should exercise the main-process resource boundary, not only renderer tab
state: same target opens collapse to one viewer, distinct targets cap and reject,
close frees a slot, create failure leaves the baseline unchanged, quit restores
baseline, and mutation checks fail when dedupe or cap is removed. Live tmux tests
must use an isolated `tmux -S` server and prove every durable source window
survives; never run resource-counting tmux tests against the operator's real tmux
server.
