---
type: Concept
title: oas-web architecture — zero-dependency localhost server plus single-file UI
description: The oas.web capability is a two-file system — bin/oas-web.mjs (a zero-dependency node:http server on 127.0.0.1) and ui/panel.html (a single self-contained HTML/CSS/JS page) — that reuses the kernel's control-pane model and tmux as its only seams to the agents.
tags: [oas-web, architecture, capability, http, tmux]
timestamp: 2026-07-22
---

# Shape

The web panel lives in `capabilities/oas-web/` and is deliberately tiny:

- `bin/oas-web.mjs` (~320 lines) — `oas web start [--port <n>] [--dir <ws>]... [--open]`.
  A `node:http` server with **zero npm dependencies**. Endpoints:
  - `GET /` — serves `ui/panel.html` verbatim.
  - `GET /api/panel?ws=<id>` — roster JSON per workspace.
  - `POST /api/spawn` — spawns an agent in an allowlisted workspace root,
    with `task: ""` meaning "await instructions" (see
    [spawn endpoint](spawn-endpoint.md)).
  - `GET /api/session/<instance>?lines=n` — raw ANSI tmux `capture-pane` text plus pane geometry, cursor state, and history depth.
  - `GET /api/chat/<instance>?limit=n` — parsed structured transcript turns.
  - `POST /api/keys` — sends browser keydown bytes into the tmux pane and is
    the panel's only text-input path (see [raw key passthrough](raw-key-passthrough-and-host-guard.md)
    and [the input-surface decision](/decisions/terminal-input-unification.md)).
  - `POST /api/interrupt/<instance>` — sends Ctrl-C.
  - `GET /api/jira/<instance>` — epic + Agent Roster via `acli` when
    `capabilityMeta["oas.jira"]` is present.
- `ui/panel.html` — all CSS, JS, rendering, panes, and polling loops in one
  file. No build step, no framework. Hard-refresh (Cmd-Shift-R) is the deploy.
  The current shell has an editor-style panes array, focused-pane key routing,
  a collapsible sidebar, and compact per-pane headers (see
  [split panes and compact shell](split-panes-and-compact-shell.md)).

# Kernel seams (all pre-existing, none owned here)

- **Roster**: `lib/control-pane/model.mjs` `collectControlPane(root)` — same
  data as the TUI (`oas pane`). The kernel is found in-tree (`../../..`) or,
  for marketplace installs, via `oas root` (a copied package must never
  assume it sits inside the kernel tree).
- **Session view + input**: tmux only — `capture-pane` to read and raw
  `/api/keys` delivery through `send-keys` / `paste-buffer` to write. The
  terminal's own input line is the sole input surface; do not reintroduce a
  separate composer or `/api/send` path. tmux is the runtime-agnostic seam:
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
bind. All POST endpoints also require loopback `Host` and, when present,
loopback `Origin`, so DNS rebinding cannot turn a hostile page into terminal
input. Endpoints that accept path-shaped browser parameters, currently
`/api/spawn`'s `agentsRoot`, must resolve them against server-computed workspace
roots rather than trusting arbitrary paths. `EADDRINUSE` is handled with a
friendly message (a panel is probably already running; `--port <n>` or
`pkill -f "oas-web.mjs start"`).
