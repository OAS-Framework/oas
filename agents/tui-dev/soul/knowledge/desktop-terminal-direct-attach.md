---
type: Decision
title: Desktop terminal is a direct tmux attach via node-pty
description: The desktop app's integrated terminal spawns node-pty running `tmux attach-session` with a validated `=session:=window` target and pipes bytes over IPC to xterm.js — no capture-pane polling, no send-keys, no WebSocket bridge.
tags: [desktop, tmux, node-pty, xterm, terminal, exact-match]
timestamp: 2026-07-23
---

Per the desktop-app contract (binding): tmux stays the durable session host;
the Electron terminal is a **viewer client**. Main process builds `target` with
[the exact-match target helper](anchor-tmux-attach-targets.md), then spawns
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
- Session and window components are validated before hitting tmux argv, then
  rendered as an exact `=session:=window` target so stale roster entries fail
  loudly instead of prefix-matching a different live window.

This is the opposite of the legacy web panel path (capture-pane polling +
send-keys through the oas-web HTTP API), which stays untouched as the
remote fallback.
