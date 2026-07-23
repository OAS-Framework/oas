---
type: Decision
title: Desktop terminal is a direct tmux attach via node-pty
description: The desktop app's integrated terminal spawns node-pty running `tmux attach-session` against an isolated per-tab tmux viewer session that contains only a link-window to the exact source window and pipes bytes over IPC to xterm.js.
tags: [desktop, tmux, node-pty, xterm, terminal, exact-match]
timestamp: 2026-07-23
---

Per the desktop-app contract (binding): tmux stays the durable session host;
the Electron terminal is a **viewer client**. Main process preflights the exact
source session/window with [the exact-match target helper](anchor-tmux-attach-targets.md),
creates a per-tab [isolated link-window viewer session](desktop-terminal-link-window-viewer-isolation.md)
that contains only that exact source window, locks the viewer's prefix/root
window-navigation keys, then spawns
`pty.spawn("tmux", ["attach-session", "-t", "=<viewer>"])` per tab. Bytes stream
over IPC channels (`term:data:<id>` / `term:write` / `term:resize` /
`term:close`), and xterm.js + fit addon render in the isolated renderer.

Key semantics, verified live:

- `pty.resize(cols, rows)` on xterm resize resizes the attached client;
  tmux reflows.
- `pty.kill()` = tmux client detach from the viewer. Tab close, app quit, and
  signals may also clean up the isolated viewer session, but they must not kill
  the linked durable source window/session.
- pty `onExit` (e.g. source window killed externally) → renderer shows a
  "session ended" banner over the frozen scrollback; the viewer never falls
  through to a sibling durable-session window.
- Session and window components are validated before hitting tmux argv. Source
  preflight uses an exact `=session:=window` target, and pty attach uses an
  exact `=<viewer>` target so stale roster entries fail loudly instead of
  prefix-matching a different live window.

This is the opposite of the legacy web panel path (capture-pane polling +
send-keys through the oas-web HTTP API), which stays untouched as the
remote fallback.
