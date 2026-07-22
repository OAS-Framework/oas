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
  - `GET /api/file` — guarded file reads for desktop viewers; realpaths the
    requested path and every allowed root before containment checks (see
    [the file guard lesson](/lessons/file-endpoint-realpath-guard.md)).
  - `GET /api/diff` — worktree diff/stat reads for desktop viewers; derives
    `<home>/work` rather than using `inst.work` and parses NUL-delimited git
    rename stats (see [the work-mode lesson](/lessons/instance-work-mode-not-path.md)
    and [the rename parsing lesson](/lessons/git-rename-stats-nul-parsing.md)).
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
  data as the TUI (`oas pane`). Slow collection runs in the hidden
  `oas-web.mjs collect` child-process path; the serving process answers
  `/api/panel` and `findInstance` from an in-memory snapshot so key/input
  endpoints are not blocked by roster rebuilds. The kernel is found in-tree
  (`../../..`) or, for marketplace installs, via `oas root` (a copied package
  must never assume it sits inside the kernel tree). Control-pane instance
  objects expose `work` as the work mode, not a filesystem path; endpoints that
  need a work tree derive `<home>/work` from `inst.home` (see
  [the work-mode lesson](/lessons/instance-work-mode-not-path.md)).
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
deferral, revisit only if polling chafes. Because the server is single-threaded,
periodic roster refresh uses a background child-process snapshot refresh rather
than synchronous `collectControlPane` work on request paths; see
[the snapshot collection lesson](/lessons/snapshot-collection-off-thread.md).

Session attach is staged for perceived speed: paint a cached frame immediately
when available, fetch a short `/api/session?lines=120` tail so the pane becomes
interactive quickly, then background-backfill the deep `/api/session?lines=2000`
scrollback. The server keeps a 2.5s instance-registry cache around
`findInstance()` so session polls do not rebuild `collectControlPane` for every
workspace on each request, and `paneInfo()` keeps pane size/history/cursor lookup
to one tmux `display-message` round-trip. The requested `lines` value is part of
the render signature so a tail paint cannot suppress the later deep backfill; see
[the fast-attach lesson](/lessons/fast-attach-cache-tail-backfill.md).

# Security invariant

The server binds **127.0.0.1 only** and must stay that way: this process can
type into your terminals. Remote use is ssh port-forward, never a public
bind. Every request requires a loopback `Host`; POST endpoints also require a
loopback `Origin` when present. The Host check must run before GET handlers too
because file-serving APIs such as `/api/file` and `/api/diff` can leak workspace
files to a DNS-rebinding page; see
[the all-request Host guard lesson](/lessons/loopback-host-guard-all-requests.md).
Browser-provided paths are selectors or targets constrained by
server-computed allowlists, never ambient filesystem authority: `/api/spawn`'s
`agentsRoot` must resolve against workspace roots, and `/api/file` must realpath
both the requested file and each allowed root before requiring exact-root or
root-plus-separator containment. `EADDRINUSE` is handled with a friendly message
(a panel is probably already running; `--port <n>` or
`pkill -f "oas-web.mjs start"`).
