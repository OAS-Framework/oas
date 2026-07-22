---
type: Concept
title: Desktop renderer views port of the panel
description: The oas-web panel maps to desktop renderer views under packages/desktop/renderer/views/ as plain mount/unmount ES modules, with a same-origin harness proxy for development.
tags: [desktop-app, renderer, views, port]
timestamp: 2026-07-22
---

# Desktop renderer views port of the panel

The desktop-app contract mandates renderer surfaces as plain ES modules in
`packages/desktop/renderer/views/` exporting `mount(el, ctx)` and `unmount()`,
with `ctx = { api(pathname, opts), openFile(path), openTerminal(instance) }`
supplied by the shell.

The panel functionality maps as three views plus a shared module:

- `instances.js` — roster plus pi-style chat transcript (`/api/chat`), summary
  head, interrupt, inline Jira card; the live terminal is delegated through
  `ctx.openTerminal(instance)` because `tui-dev` owns that view, and the
  hand-rolled ANSI mirror was deliberately not ported.
- `spawn.js` — `/api/agents` plus `POST /api/spawn` with purpose/task. Panel
  defaults are preserved: empty task means awaiting instructions, and
  attached-mode agents are not spawnable standalone. See the
  [spawn endpoint contract](/architecture/spawn-endpoint.md).
- `jira.js` — first full UI over `/api/jira/<instance>`. The browser panel
  exposed the endpoint but never rendered it, so this view was built from the
  `jiraPanel()` response shape rather than legacy UI.
- `common.js` — escape/mini-markdown helpers, `ctx.api` JSON wrappers, roster
  grouping, and workspace switching (`?ws=`) shared across views through a
  localStorage-backed `setWorkspace`/`onWorkspaceChange` bus so a shell-level
  switcher can drive all views at once. This extends the
  [multi-workspace switcher](/architecture/multi-workspace-switcher.md) shape.

`theme.css` carries the panel tokens scoped under `.oas-view` so shell chrome is
unaffected. The pi-style transcript UI itself was recovered from git history
(`git show 002a442:capabilities/oas-web/ui/panel.html`) because the current
panel is terminal-mirror-only and no longer contains it.

# Harness proxy gotcha

`oas-web` sends no CORS headers and its loopback origin guard rejects cross-port
POSTs, so a plain static file server cannot host the harness. The desktop
renderer `harness-server.mjs` serves the renderer dir and proxies `/api/*` to
the `oas-web` server, rewriting `Host`/`Origin` to the API's loopback authority,
so harness development stays same-origin like the real shell.
