---
type: Decision
title: Desktop terminal is a direct tmux attach via node-pty
description: The desktop app's integrated terminal spawns node-pty running `tmux attach-session -t <session>:<window>` and pipes bytes over IPC to xterm.js — no capture-pane polling, no send-keys, no WebSocket bridge; closing the tab kills the pty only.
tags: [desktop, tmux, node-pty, xterm, terminal]
timestamp: 2026-07-22
---

Per the desktop-app contract (binding): tmux stays the durable session host;
the Electron terminal is a **viewer client**. Main process spawns
`pty.spawn("tmux", ["attach-session", "-t", target])` per tab, streams data
over IPC channels (`term:data:<id>` / `term:write` / `term:resize` /
`term:close`), and xterm.js + fit addon render in the isolated renderer.

Key semantics, verified live:

- `pty.resize(cols, rows)` on xterm resize resizes the attached client;
  tmux reflows.
- `pty.kill()` = tmux client detach. The session ALWAYS survives — tab
  close, app quit, and signals all only kill ptys.
- pty `onExit` (e.g. session killed externally) → renderer shows a
  "session ended" banner over the frozen scrollback.
- Session names are validated (`/^[\w@%.:-]+$/`) in main before hitting
  tmux argv.

This is the opposite of the legacy web panel path (capture-pane polling +
send-keys through the oas-web HTTP API), which stays untouched as the
remote fallback.
