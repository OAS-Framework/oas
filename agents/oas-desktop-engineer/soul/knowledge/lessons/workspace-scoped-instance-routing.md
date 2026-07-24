---
type: Lesson
title: Scope instance-name endpoints by workspace ID
description: Instance names are only unique within a workspace, so instance-name APIs must forward the selected ?ws= end to end — views build per-instance paths through a shared ws-appending helper, and the server's findInstance(name, wsId) fails closed inside that workspace rather than falling back to the first global match.
tags: [desktop-backend, desktop-app, multi-workspace, routing, security, safety]
timestamp: 2026-07-22
---

# The trap

Multiple watched workspaces can have live instances with the same name. The
legacy `findInstance(name)` behavior returned the first match across all
workspace snapshots; if an instance-addressed request omitted workspace scope,
a request such as `/api/keys` could target the wrong same-named instance —
and merged-state review found exactly this in the desktop views: unscoped
`/api/interrupt/<name>`, `/api/chat/<name>`, `/api/jira/<name>` meant an
Interrupt clicked while viewing workspace B could Ctrl-C workspace A's tmux
session, and chat/Jira could expose the wrong workspace's data.

# Rule — server side

When the UI knows the selected workspace, instance-name APIs must forward that
workspace as `?ws=` and the server must resolve with `findInstance(name, wsId)`:

- With `wsId`, search only that workspace's snapshot.
- Unknown workspace IDs or missing instances return no match, which the route
  reports as 404. Do not fall back to the first workspace or first global match;
  for key delivery, a hard error is safer than misrouting bytes.
- Without `wsId`, the legacy first-match-across-workspaces lookup remains for
  callers that have no workspace scope.
- Cold start can still do the one inline snapshot collection before the scoped
  branch; scoping changes which workspace snapshot is searched, not whether the
  snapshot is warm.

The affected instance-name route family is `session`, `keys`, `interrupt`,
`jira`, `chat`, and `diff`. `/api/file` intentionally stays outside this rule:
its requests use absolute file paths guarded by the realpath allowlist, not an
instance-name lookup.

# Rule — view side

View code must not hand-build `/api/<kind>/<name>` strings. Use one shared
path builder — `instanceApiPath(kind, instance, query)` in the desktop views'
`common.mjs` — that appends the selected workspace to EVERY per-instance
endpoint, so future callers (session, keys) inherit the scoping for free. See
the [desktop renderer views port](/architecture/desktop-renderer-views-port.md).

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

# Related concepts

- [Multi-workspace support](/architecture/multi-workspace-switcher.md)
- [desktop backend architecture](/architecture/desktop-backend-architecture.md)
- [Raw key passthrough and the loopback Host/Origin guards](/architecture/raw-key-passthrough-and-host-guard.md)
- [Guard file-serving paths with admitted canonical roots](/lessons/file-endpoint-realpath-guard.md)
- [Desktop renderer views port](/architecture/desktop-renderer-views-port.md)
