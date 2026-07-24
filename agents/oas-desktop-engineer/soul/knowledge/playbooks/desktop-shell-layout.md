---
type: Playbook
title: Desktop shell view-host contract and layout
description: Where things live in packages/desktop and how feature views integrate — mount(el, ctx) may return a disposer, unmount() remains the module-level fallback, and ctx = { api, openFile, openTerminal } is provided by the shell.
tags: [desktop, electron, view-host, contract]
timestamp: 2026-07-24
---

`packages/desktop/` layout (the desktop shell is the ctx/view-host provider):

- `main.mjs` — Electron main: connect-or-spawn the bundled backend server (port 4820, env
  `OAS_DESKTOP_PORT`, workspace via `--dir`/`OAS_DESKTOP_DIR`), IPC `api`
  proxy (renderer never touches the network), node-pty terminal channels.
- `server/` — the bundled zero-dependency backend (`oas-web.mjs` + the
  roster collector `model.mjs`); see
  [desktop backend architecture](/architecture/desktop-backend-architecture.md).
- `preload.cjs` — contextBridge → `window.oasDesktop`; contextIsolation ON,
  nodeIntegration OFF, `sandbox: false` (preload needs require).
- `renderer/shell.mjs` — contextual sidebar, stage host, artifact-tab host,
  command palette, recursive instance roster, integrated terminals.
- `renderer/views/` — the shipped feature views, all owned by this soul:
  `brain`, `markdown`, `diff`, `hierarchy`, `instances`, `jira`, `spawn`,
  plus `common.mjs` (shared helpers + workspace bus). Contract:
  `export mount(el, ctx)` / `unmount()`.
  `mount()` may return a per-mount disposer; the tab host prefers that
  disposer at close, while module-level `unmount()` remains the fallback and
  all-mounts cleanup hook. See [View contract extension — mount() may return a
  per-mount disposer](/decisions/view-mount-disposer-contract.md). `ctx = { api(pathname,
  opts), openFile(path), openTerminal(instance) }`, plus per-tab extras spread
  into ctx (brain gets `agent`, `instance`, `agentsRoot`; diff gets
  `instance`; markdown gets `path`).

The ctx/view contract is this soul's to steward: change it deliberately,
update every shipped view and the shared harness in the same change, and
escalate to the maintainer (oas-expert) when a change would break external
expectations. UX/layout aspects of a contract change go through ux-designer.

npm quirks: `npm install` then `npm run rebuild` (@electron/rebuild for
node-pty against the Electron ABI). The package is `private: true` and not
in the root `files` set; root gate stays green because node --test ignores
node_modules and packages/ was already unpublished.
