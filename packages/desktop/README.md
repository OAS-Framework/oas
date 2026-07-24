# @oas-framework/desktop

The OAS desktop app — a VS Code-style Electron shell around the OAS control
panel, with a **real integrated terminal** (xterm.js + node-pty attaching
straight to the agents' tmux sessions).

Private package: NOT part of the published npm `files` set of the root
package; its dependencies (electron, node-pty, xterm) live here only.

## Run

```bash
cd packages/desktop
npm install          # postinstall bundles renderer/vendor/highlight.mjs (esbuild)
npm run rebuild      # rebuild node-pty against the Electron ABI (first install / electron upgrade)
npm start            # launches the app; connects to the backend server on 127.0.0.1:4820 or spawns the bundled one
```

Flags/env:
- `--dir <workspace>` / `OAS_DESKTOP_DIR` — the OAS workspace the panel shows
  (default: this repo's root).
- `OAS_DESKTOP_PORT` — backend server port (default 4820).

## UX and architecture

The shell has three navigation contexts:

- **Active overview** — the home surface: a fitted, zoomable tidy tree of
  running and idle instances with `parentInstance` spawn relationships. Agent boxes can
  be repositioned freely; edges follow live.
- **Instances** — the shell's single sidebar becomes a compact, recursively
  nested roster. Selecting a running instance opens its direct tmux-attach
  xterm terminal in the main area. Terminal tabs are scoped to this context.
- **Soul roster** — searchable soul cards with explicit **Spawn** and
  **View brain** actions. Brain and markdown artifacts are scoped to this
  context; the markdown reader is the flagship file surface.

Diff and Jira UI are intentionally dormant: their modules/API support stay in
this private package, but the shell exposes no navigation, tabs, or inline
cards for them.

- `main.mjs` — Electron main: server management (connect-or-spawn the bundled server),
  IPC `api` proxy, node-pty terminals (`tmux attach-session -t <target>`).
  Closing a terminal tab kills the pty ONLY — tmux sessions are the durable
  hosts and always survive.
- `server/oas-web.mjs` — the bundled zero-dependency backend: a loopback-only
  `node:http` server exposing the `/api/*` surface (roster, spawn, brain,
  session capture, keys, file, diff). `server/model.mjs` is the roster
  collector. Binds 127.0.0.1 only — it can type into your terminals.
- `preload.cjs` — contextBridge surface (`window.oasDesktop`); renderer runs
  with contextIsolation on, nodeIntegration off.
- `renderer/shell.mjs` — contextual single sidebar, stage host, artifact-tab
  host, command palette, recursive instance roster, and integrated terminals.
- `renderer/views/*.mjs` — feature views per the shared contract:
  `mount(el, ctx)` / `unmount()`, `ctx = { api, openFile, openTerminal }`.
  The shell adds feature-detected `openBrain` / `openView` affordances.
  `mount()` MAY return a disposer function; the host prefers it over the
  module-level `unmount()` (required for multi-mounted views such as markdown).
  `views/common.mjs` carries shared helpers and the workspace bus;
  `theme.css` carries AA dark + solarized-light semantic tokens. Bare ESM deps
  (marked, dompurify, highlight.js) resolve through the importmap in
  `index.html`; highlight.js is bundled to `renderer/vendor/` by
  `build-vendor.mjs` (postinstall) because its `es/` entry is a
  dual-package CJS shim browsers cannot load.
