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

The panel functionality maps as three `.mjs` views plus a shared `.mjs` module;
the shell host imports views by name as `./views/<name>.mjs`:

- `instances.mjs` — roster plus pi-style chat transcript (`/api/chat`), summary
  head, interrupt, inline Jira card; the live terminal is delegated through
  `ctx.openTerminal(instance)` because `tui-dev` owns that view, and the
  hand-rolled ANSI mirror was deliberately not ported.
- `spawn.mjs` — `/api/agents` plus `POST /api/spawn` with purpose/task. Panel
  defaults are preserved: empty task means awaiting instructions, and
  attached-mode agents are not spawnable standalone. See the
  [spawn endpoint contract](/architecture/spawn-endpoint.md).
- `jira.mjs` — first full UI over `/api/jira/<instance>`. The browser panel
  exposed the endpoint but never rendered it, so this view was built from the
  `jiraPanel()` response shape rather than legacy UI.
- `common.mjs` — escape/mini-markdown helpers, `ctx.api` JSON wrappers that
  tolerate both harness Fetch `Response` objects and shell-parsed JSON, roster
  grouping, and workspace switching (`?ws=`) shared across views through an
  in-memory `setWorkspace`/`onWorkspaceChange` bus (localStorage persists the
  selection only) so a shell-level switcher can drive all views at once.
  `instanceApiPath(kind, instance, query)` appends the selected workspace to
  every per-instance request instead of letting views hand-build ambiguous
  `/api/<kind>/<name>` paths. This extends the
  [multi-workspace switcher](/architecture/multi-workspace-switcher.md) shape
  and follows [the workspace-scoping lesson](/lessons/workspace-scoped-instance-routing.md).

`theme.css` carries the panel tokens scoped under `.oas-view` so shell chrome is
unaffected; `ensureTheme`'s fallback resolves `../theme.css` relative to the
`views/` modules, and the harness preloads CSS in a way that can mask a broken
fallback. The pi-style transcript UI itself was recovered from git history
(`git show 002a442:capabilities/oas-web/ui/panel.html`) because the current
panel is terminal-mirror-only and no longer contains it.

# Harness proxy gotcha

`oas-web` sends no CORS headers and its loopback origin guard rejects cross-port
POSTs, so a plain static file server cannot host the harness. The desktop
renderer `harness-server.mjs` serves the renderer dir and proxies `/api/*` to the
`oas-web` server so harness development stays same-origin like the real shell.
There is ONE shared harness (`harness.html`, a tab per view); standalone
per-view harness/proxy pairs (like the retired `dev-serve.mjs`) are not kept.

The proxy must apply the same loopback `Host` check before serving static files
or proxying `/api/*`. For POSTs it must also validate the inbound `Origin`. It
must not launder browser origins by rewriting `Origin` to the API's loopback
authority; forward the browser's real `Origin` unchanged, and rewrite only
`Host` for upstream routing after the inbound host has been accepted. See
[Harness proxy must guard origins, not launder them](/lessons/harness-proxy-origin-guard.md).
