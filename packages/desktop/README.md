# @oas-framework/desktop

The OAS desktop app — a VS Code-style Electron shell around the OAS control
panel, with a **real integrated terminal** (xterm.js + node-pty attaching
straight to the agents' tmux sessions).

Private package: NOT part of the published npm `files` set of the root
package; its dependencies (electron, node-pty, xterm) live here only.

## Run

```bash
cd packages/desktop
npm install          # also rebuilds node-pty for Electron (postinstall-free: run `npm run rebuild` if needed)
npm run rebuild      # rebuild node-pty against the Electron ABI (first install / electron upgrade)
npm start            # launches the app; connects to oas-web on 127.0.0.1:4820 or spawns it
```

Flags/env:
- `--dir <workspace>` / `OAS_DESKTOP_DIR` — the OAS workspace the panel shows
  (default: this repo's root).
- `OAS_DESKTOP_PORT` — oas-web server port (default 4820).

## Architecture

- `main.mjs` — Electron main: server management (connect-or-spawn oas-web),
  IPC `api` proxy, node-pty terminals (`tmux attach-session -t <target>`).
  Closing a terminal tab kills the pty ONLY — tmux sessions are the durable
  hosts and always survive.
- `preload.cjs` — contextBridge surface (`window.oasDesktop`); renderer runs
  with contextIsolation on, nodeIntegration off.
- `renderer/shell.mjs` — sidebar roster (polls `/api/panel`), agents list,
  tabbed view host, integrated terminal tabs.
- `renderer/views/*.mjs` — feature views per the shared contract:
  `mount(el, ctx)` / `unmount()`, `ctx = { api, openFile, openTerminal }`.
  brain / markdown / diff / chat ship as placeholders here; their owning
  developers replace them.
