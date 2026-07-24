# oas desktop — renderer views (webpanel-dev)

Ports of the retired browser panel's functionality as desktop renderer views,
per the desktop-app contract: each view is a plain ES module exporting
`mount(el, ctx)` / `unmount()`, where `ctx = { api(pathname, opts),
openFile(path), openTerminal(instance) }` is provided by the shell.
No frameworks, no dependencies; data comes from the bundled backend HTTP API.

## Views (`views/`)

- **instances.mjs** — roster + instance detail: pi-style chat transcript
  (`GET /api/chat/<instance>`), task/state/git/workspace summary, interrupt,
  inline Jira card when the instance carries `oas.jira` meta. The live
  terminal is NOT here — the "Open terminal" action calls
  `ctx.openTerminal(instance)` (the shell's terminal view owns interaction).
- **spawn.mjs** — available agents (`GET /api/agents`) with spawn-from-app
  (`POST /api/spawn`), purpose/task fields. Panel defaults hold: empty task
  spawns an instance awaiting instructions; attached-mode agents are not
  spawnable standalone.
- **jira.mjs** — epic + Agent Roster panel per Jira-linked instance
  (`GET /api/jira/<instance>`).
- **common.mjs** — shared helpers: escaping, mini-markdown, ctx.api JSON
  wrappers, roster grouping, and workspace switching (`?ws=`) — the selected
  workspace is shared across views via `setWorkspace`/`onWorkspaceChange`
  (persisted in localStorage), so a shell-level switcher can drive it too.

`theme.css` carries the panel's semantic design tokens (dark + solarised
light, WCAG AA); views style themselves against tokens only, scoped under
`.oas-view` so shell chrome is unaffected.

## Developing without the shell

`harness.html` supplies a stub `ctx` and tab chrome for ALL views — including
the Markdown and Diff tabs (they prompt for a file path / instance name;
`ctx.openFile` routes into the markdown view); `harness-server.mjs`
serves it and proxies `/api/*` to a running backend server (same-origin, so
GETs and guarded POSTs both work exactly as in the real shell):

```sh
node packages/desktop/server/oas-web.mjs start --port 4821 --dir <workspace>
node packages/desktop/renderer/harness-server.mjs --port 4899 --api http://127.0.0.1:4821
open "http://127.0.0.1:4899/"
```
