---
type: Decision
title: Per-tab grouped tmux viewer sessions for the desktop terminal
description: Desktop terminal tabs attach to per-tab tmux sessions grouped to the durable session, with each viewer's current-window selection pinned to the exact target window so concurrent clients cannot steer tabs by changing the durable session selection.
tags: [tmux, desktop, terminal, grouped-session, viewer, exact-match]
timestamp: 2026-07-23
---

Anchoring an `attach-session` target is exact only at attach time. If the
node-pty client attaches directly to the durable session, that client then
follows the durable session's shared current-window selection; any other client
that switches the durable session's current window can silently steer every open
desktop tab to the wrong agent while the tab labels stay unchanged.

The desktop terminal should therefore create one tmux **viewer session** per tab
and group it to the durable session with `new-session -t =<durable>`. A grouped
session shares the durable session's window set but has an independent
current-window selection. After creation, select the exact target window inside
the viewer session, then attach the pty to `=<viewer>`.

# Rules

- Name viewer sessions `oasdesk-<pid>-<seq>-<rand>` so they are unique,
  unpredictable, and pid-prefixed for exact orphan cleanup.
- Preflight the exact durable source target first; fail closed if the intended
  source session/window is absent.
- Select the exact window in the viewer session after creating it; do not rely
  on the durable session's current-window selection.
- Kill only the `=`-anchored viewer session on tab close, pty exit, desktop
  shutdown, and mid-open failure; a create-then-fail path must not leak a
  viewer.
- Sweep `oasdesk-` viewer sessions at app start and quit only when their pid is
  dead, so crashed desktops are cleaned up without touching live desktops or
  foreign tmux sessions.

This preserves the architecture in [Desktop terminal is a direct tmux attach via
node-pty](desktop-terminal-direct-attach.md): the desktop still uses a direct
pty-to-tmux client path, not capture-pane polling, send-keys, or a WebSocket
bridge. Grouping is the tmux mechanism that makes that direct attach correct
under concurrent tmux clients.
