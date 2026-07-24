---
type: Lesson
title: Verifying an Electron app headlessly via CDP and ELECTRON_RUN_AS_NODE
description: CDP and ELECTRON_RUN_AS_NODE can verify Electron, but packaged GUI launches belong in CI; on operator machines use static checks, direct loopback-server checks, or CDP against one operator-launched app.
tags: [electron, testing, node-pty, cdp]
timestamp: 2026-07-24
---

Two techniques verified while building `packages/desktop/` (OAS desktop shell).
Guardrail: do not use this concept as permission to spawn the packaged `OAS
Desktop.app` from an agent session on the operator's machine. Packaged GUI
launches belong in CI; locally, follow [never launch packaged GUI apps from
agent sessions on operator machines](/lessons/no-packaged-gui-launches-local.md).

1. **Renderer verification via CDP**: in CI, throwaway runners, or non-packaged
   development-shell contexts, launch with `npx electron . --remote-debugging-port=9223`,
   get the page's `webSocketDebuggerUrl` from `http://127.0.0.1:9223/json`,
   then use Node's built-in `WebSocket` and
   `Runtime.evaluate` (with `awaitPromise: true, returnByValue: true`) to query
   the DOM, click buttons, and assert rendered state (e.g. `.xterm-rows`
   content proves the terminal is live). For packaged-app parity on the
   operator machine, connect only to one app instance the operator launched and
   will close manually. No puppeteer dependency needed.

2. **Native-module checks under the Electron ABI**: node-pty compiled by
   `@electron/rebuild` will NOT load in plain `node` (ABI mismatch). Run test
   scripts with `ELECTRON_RUN_AS_NODE=1 npx electron script.mjs`. The script
   must live inside the package dir — `createRequire` resolves `node-pty`
   from the script's path, so `/tmp` scripts fail with MODULE_NOT_FOUND.

Gotcha: Electron's `before-quit` does NOT fire on SIGTERM/SIGINT — a spawned
child server (oas-web) leaked on `kill <pid>` until explicit
`process.on(sig, ...)` handlers called the shutdown path.
