---
type: Concept
title: Desktop backend architecture — zero-dependency localhost server bundled in the app
description: The desktop backend is a zero-dependency node:http server on 127.0.0.1 bundled at packages/desktop/server/, spawned by the Electron main process, serving the /api surface to the desktop renderer (its only client) and reusing the roster model and tmux as its only seams to the agents.
tags: [desktop, backend, architecture, http, tmux]
timestamp: 2026-07-24
---

# Shape

The backend lives in `packages/desktop/server/` (migrated from the retired
`capabilities/oas-web/` capability) and is deliberately tiny:

- the server entrypoint — a `node:http` server with **zero npm dependencies**,
  spawned by the Electron main process (`main.mjs`); `--port <n>` and
  repeatable `--dir <ws>` are still honored. Endpoints:
  - `GET /api/panel?ws=<id>` — roster JSON per workspace.
  - `POST /api/spawn` — spawns an agent in an allowlisted workspace root,
    with `task: ""` meaning "await instructions" (see
    [spawn endpoint](/architecture/spawn-endpoint.md)).
  - `GET /api/brain/<agent>?ws=<id>` — returns soul artifact paths, package-level
    capability-agent skills, and workspace-scoped running-state for the desktop
    brain view while resolving agent names through kernel lookup seams (see
    [agent brain endpoint](/architecture/agent-brain-endpoint-and-view.md)).
  - `GET /api/session/<instance>?ws=<id>&lines=n` — raw ANSI tmux `capture-pane` text plus pane geometry, cursor state, and history depth.
  - `GET /api/chat/<instance>?ws=<id>&limit=n` — parsed structured transcript turns.
  - `GET /api/file` — guarded file reads for desktop viewers; realpaths the
    requested path and every allowed root before containment checks (see
    [the file guard lesson](/lessons/file-endpoint-realpath-guard.md)).
  - `GET /api/diff` — worktree diff/stat reads for desktop viewers; derives
    `<home>/work` rather than using `inst.work` and parses NUL-delimited git
    rename stats (see [the work-mode lesson](/lessons/instance-work-mode-not-path.md)
    and [the rename parsing lesson](/lessons/git-rename-stats-nul-parsing.md)).
  - `POST /api/keys?ws=<id>` — sends client keydown bytes into the tmux pane
    (see [raw key passthrough](/architecture/raw-key-passthrough-and-host-guard.md)
    and [the input-surface decision](/decisions/terminal-input-unification.md)).
  - `POST /api/interrupt/<instance>?ws=<id>` — sends Ctrl-C.
  - `GET /api/jira/<instance>?ws=<id>` — epic + Agent Roster via `acli` when
    `capabilityMeta["oas.jira"]` is present.
  Instance-addressed routes (`session`, `keys`, `interrupt`, `jira`, `chat`,
  and `diff`) forward `?ws=` when the UI has a selected workspace, so
  `findInstance(name, wsId)` resolves same-named instances strictly inside that
  workspace — unscoped global lookup is ambiguous when instance names collide
  across workspaces; see [the workspace-scoping lesson](/lessons/workspace-scoped-instance-routing.md).
- **the desktop renderer is the only client** — the browser panel UI
  (`ui/panel.html`) died with the capability; the server serves no HTML. The
  renderer views live in `packages/desktop/renderer/` (see
  [desktop renderer views port](/architecture/desktop-renderer-views-port.md)).

# Kernel seams (all pre-existing, none owned here)

- **Roster**: the roster model (`collectControlPane(root)`, bundled with the
  server after `lib/control-pane/` was deleted) — the same collector the old
  TUI used. Slow collection runs in a hidden `collect` child-process path; the
  serving process answers `/api/panel` and `findInstance(name, wsId)` from an
  in-memory snapshot so
  key/input endpoints are not blocked by roster rebuilds, and scoped instance
  lookups fail closed inside the supplied workspace instead of falling back to a
  global first match. Callers that have resolved a workspace must pass that
  workspace id so same-named instances in other workspaces do not leak into
  running-state or terminal decisions (see
  [the scoped snapshot lookup lesson](/lessons/workspace-scoped-snapshot-lookups.md)).
  FRAMEWORK_ROOT resolution belongs to the app: `main.mjs` resolves the kernel
  and the bundled server must not assume a capability-install path.
  **The direct import of `lib/core.mjs` via FRAMEWORK_ROOT is transitional
  migration debt**, not a durable boundary: per the desktop-succession
  decision, operational OAS mutations belong behind a compatible installed
  `oas ... --json` CLI, with observation-only degradation when no compatible
  OAS install exists. Do not extend the direct-core bridge; retire it when
  the CLI boundary lands.
  Roster instance
  objects expose `work` as the work mode, not a filesystem path; endpoints that
  need a work tree derive `<home>/work` from `inst.home` (see
  [the work-mode lesson](/lessons/instance-work-mode-not-path.md)).
- **Session view + input**: tmux only — `capture-pane` to read and raw
  `/api/keys` delivery through `send-keys` / `paste-buffer` to write. The
  terminal's own input line is the sole input surface; do not reintroduce a
  separate composer or `/api/send` path. tmux is the runtime-agnostic seam:
  identical for pi and claude sessions.
- **Chat view**: the runtime's own session JSONL logs (see
  [transcript-data-sources](/architecture/transcript-data-sources.md)) — read-only, no
  runtime cooperation needed.

# Update model

The renderer polls JSON endpoints (roster ~5s, chat 1.5s, 400ms fast loop after a
send). No WebSockets/SSE — deliberate
deferral, revisit only if polling chafes. Because the server is single-threaded,
periodic roster refresh uses a background child-process snapshot refresh rather
than synchronous `collectControlPane` work on request paths; see
[the snapshot collection lesson](/lessons/snapshot-collection-off-thread.md).

Session attach is staged for perceived speed: paint a cached frame immediately
when available, fetch a short `/api/session?lines=120` tail so the pane becomes
interactive quickly, then background-backfill the deep `/api/session?lines=2000`
scrollback. The server keeps a 2.5s instance-registry cache around
`findInstance(name, wsId)` so session polls do not rebuild `collectControlPane`
for every workspace on each request, and `paneInfo()` keeps pane
size/history/cursor lookup to one tmux metadata query. The requested `lines`
value is part of the render signature so a tail paint cannot suppress the later
deep backfill; see
[the fast-attach lesson](/lessons/fast-attach-cache-tail-backfill.md).

Tmux targets are exact-match anchored as validated `=session:=window` strings so
stale rosters cannot prefix-match similarly named live windows. When missing
panes must fail closed, pane metadata reads use `list-panes` rather than
`display-message`, because `display-message` can fall back to a default context;
see [the tmux target anchoring lesson](/lessons/tmux-anchored-targets-and-display-message-fallback.md).

# Security invariant

The server binds **127.0.0.1 only** and must stay that way: this process can
type into your terminals. Remote use is ssh port-forward, never a public
bind. Every request requires a loopback `Host`; POST endpoints also require a
loopback `Origin` when present. The Host check must run before GET handlers too
because file-serving APIs such as `/api/file` and `/api/diff` can leak workspace
files to a DNS-rebinding page; see
[the all-request Host guard lesson](/lessons/loopback-host-guard-all-requests.md).
The server sends no CORS headers; external dev harnesses cannot fetch
its API cross-origin and should use a same-origin proxy such as
`packages/desktop/renderer/harness-server.mjs` for renderer work.
Client-provided paths are selectors or targets constrained by
server-computed allowlists, never ambient filesystem authority: `/api/spawn`'s
`agentsRoot` must resolve against workspace roots, and `/api/file` must realpath
both the requested file and each allowed root before requiring exact-root or
root-plus-separator containment. `EADDRINUSE` is handled with a friendly
message (a server is probably already running; see the server-host reuse path
and [the identity-probe lesson](/lessons/server-reuse-identity-probe.md)).
