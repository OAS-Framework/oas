---
type: Playbook
title: Desktop shell view-host contract and layout
description: Where things live in packages/desktop and how feature views integrate — mount(el, ctx) may return a disposer, unmount() remains the module-level fallback, and ctx = { api, openFile, openTerminal } is provided by the shell.
tags: [desktop, electron, view-host, contract]
timestamp: 2026-07-22
---

`packages/desktop/` layout (the desktop shell is the ctx/view-host provider):

- `main.mjs` — Electron main: connect-or-spawn the bundled backend server (port 4820, env
  `OAS_DESKTOP_PORT`, workspace via `--dir`/`OAS_DESKTOP_DIR`), IPC `api`
  proxy (renderer never touches the network), node-pty terminal channels.
- `preload.cjs` — contextBridge → `window.oasDesktop`; contextIsolation ON,
  nodeIntegration OFF, `sandbox: false` (preload needs require).
- `renderer/shell.mjs` — sidebar roster (3s `/api/panel` poll with
  JSON-diff to skip DOM churn), agents list, tab bar, view host.
- `renderer/views/{brain,markdown,diff,chat}.mjs` — placeholders other
  developers replace; contract: `export mount(el, ctx)` / `unmount()`.
  `mount()` may return a per-mount disposer; the tab host prefers that
  disposer at close, while module-level `unmount()` remains the fallback and
  all-mounts cleanup hook. See [View contract extension — mount() may return a
  per-mount disposer](/decisions/view-mount-disposer-contract.md). `ctx = { api(pathname,
  opts), openFile(path), openTerminal(instance) }`, plus per-tab extras spread
  into ctx (brain gets `agent`, `instance`, `agentsRoot`; diff/chat get
  `instance`; markdown gets `path`).

Any change to the ctx/view contract must be mailed to dev-coordinator-1
BEFORE landing — four developers build against it.

npm quirks: `npm install` then `npm run rebuild` (@electron/rebuild for
node-pty against the Electron ABI). The package is `private: true` and not
in the root `files` set; root gate stays green because node --test ignores
node_modules and packages/ was already unpublished.
