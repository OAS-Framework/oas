---
type: Lesson
title: Per-instance API calls must be workspace-scoped
description: Instance names are only unique within a workspace, so every per-instance oas-web request from a view must carry the selected ?ws= or a global lookup can affect or read the wrong workspace.
tags: [desktop-app, workspace, security, ws-scoping, review-lesson]
timestamp: 2026-07-22
---

# Per-instance API calls must be workspace-scoped

Merged-state review of `feature/desktop-app` found views building
`/api/interrupt/<name>`, `/api/chat/<name>`, and `/api/jira/<name>` without
`?ws=...`. Instance names are only unique within a workspace; an unscoped
server `findInstance(name)` can resolve "first match anywhere", so an
Interrupt clicked while viewing workspace B can Ctrl-C workspace A's tmux
session, and chat/Jira can expose the wrong workspace's data.

The server supports `findInstance(name, wsId)` with strict misses for unknown
workspaces. View code should use a shared path builder such as
`instanceApiPath(kind, instance, query)` instead of hand-building
`/api/<kind>/<name>` strings, and should append the selected workspace to every
per-instance endpoint: interrupt, chat, Jira, session, and keys. See the
[multi-workspace switcher](/architecture/multi-workspace-switcher.md) and the
[desktop renderer views port](/architecture/desktop-renderer-views-port.md).

# Test pattern

Keep the selected workspace in memory; localStorage is persistence only. That
lets DOM-free node tests call `setWorkspace`, run against a fake two-workspace
upstream with the same instance name in both, and assert the request lands only
in the selected workspace while a wrong-ws lookup returns a strict 404.

# Regression-authoring gotchas

When appending a test after an existing test's `try { ... } finally` tail via
exact-text edit, anchor on the `finally` block too; replacing only the closing
lines can silently delete it and break the whole file's parse.

`packages/desktop` has its own npm dependencies (`marked`, `highlight.js`).
After merging the `tui-dev` shell, run `npm ci` there or the root suite can
fail with `ERR_MODULE_NOT_FOUND`.
