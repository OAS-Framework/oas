---
type: Concept
title: oas-web architecture — zero-dependency localhost server plus single-file UI
description: The oas.web capability is a two-file system — bin/oas-web.mjs (a zero-dependency node:http server on 127.0.0.1) and ui/panel.html (a single self-contained HTML/CSS/JS page) — that reuses the kernel's control-pane model and tmux as its only seams to the agents.
tags: [oas-web, architecture, capability, http, tmux]
timestamp: 2026-07-21
---

# Shape

The web panel lives in `capabilities/oas-web/` and is deliberately tiny:

- `bin/oas-web.mjs` (~320 lines) — `oas web start [--port <n>] [--dir <ws>]... [--open]`.
  A `node:http` server with **zero npm dependencies**. Endpoints:
  - `GET /` — serves `ui/panel.html` verbatim.
  - `GET /api/panel?ws=<id>` — roster JSON per workspace.
  - `GET /api/session/<instance>?lines=n` — raw ANSI tmux `capture-pane` text.
  - `GET /api/chat/<instance>?limit=n` — parsed structured transcript turns.
  - `POST /api/send/<instance>` — types `{ text }` into the tmux session.
  - `POST /api/interrupt/<instance>` — sends Ctrl-C.
  - `GET /api/jira/<instance>` — epic + Agent Roster via `acli` when
    `capabilityMeta["oas.jira"]` is present.
- `ui/panel.html` (~620 lines) — all CSS, JS, rendering, polling loops in one
  file. No build step, no framework. Hard-refresh (Cmd-Shift-R) is the deploy.

# Kernel seams (all pre-existing, none owned here)

- **Roster**: `lib/control-pane/model.mjs` `collectControlPane(root)` — same
  data as the TUI (`oas pane`). The kernel is found in-tree (`../../..`) or,
  for marketplace installs, via `oas root` (a copied package must never
  assume it sits inside the kernel tree).
- **Session view + input**: tmux only — `capture-pane -p -e -J` to read,
  `send-keys` / `paste-buffer` to write. tmux is the runtime-agnostic seam:
  identical for pi and claude sessions.
- **Chat view**: the runtime's own session JSONL logs (see
  [transcript-data-sources](transcript-data-sources.md)) — read-only, no
  runtime cooperation needed.

# Update model

The UI polls JSON endpoints (roster ~5s, chat 1.5s, 400ms fast loop after a
send). No WebSockets/SSE — matches the TUI's refresh loop; deliberate
deferral, revisit only if polling chafes.

# Security invariant

The server binds **127.0.0.1 only** and must stay that way: this process can
type into your terminals. Remote use is ssh port-forward, never a public
bind. `EADDRINUSE` is handled with a friendly message (a panel is probably
already running; `--port <n>` or `pkill -f "oas-web.mjs start"`).
