---
type: Lesson
title: Electron desktop shell hardening review lessons
description: First desktop shell review findings to preserve: block same-window navigation and foreign-frame IPC, verify oas-web serves the requested workspace, and audit Electron/toolchain dev dependencies at scaffold time.
tags: [electron, security, desktop, review]
timestamp: 2026-07-22
---

A first-review pass on the desktop shell (`reviewer-597fbfc`, commit `597fbfc`,
NEEDS CHANGES) found three issues that were fixed in the follow-up commit and
should remain part of future desktop-shell work:

1. **`setWindowOpenHandler` is not enough.** Same-window navigation
   (`will-navigate`) must also be denied, or a link in rendered content
   (markdown, chat, etc.) can load a remote page that inherits the preload
   bridge and gets API/terminal access. Belt-and-braces: every privileged
   `ipcMain` handler should also check `event.senderFrame.url` against the
   exact renderer `file:` URL, for example with a `guard(e)` helper; a foreign
   frame gets an exception.

2. **"Some server answers on the port" is not "the right server".** `oas-web`
   serves the `--dir`s it was started with; connecting blindly to port `4820`
   can show — and type into — a different workspace's agents. Ensure-server
   logic must fetch `/api/panel`, match the requested workspace against
   `workspaces[].id` (equal or path-prefix), pin `?ws=<id>` on roster/agents
   requests, and otherwise start a dedicated server on the next free port with
   a deterministic scan rather than a random port.

3. **Audit dev dependencies at scaffold time.** `npm audit --include=dev`
   caught Electron 33 high-severity CVEs and vulnerable `@electron/rebuild`
   3.x `tar`. Electron 43.2.0 plus `@electron/rebuild` 4.2.0 produced zero
   reported vulnerabilities, and `node-pty` rebuilt successfully against the
   new ABI.
