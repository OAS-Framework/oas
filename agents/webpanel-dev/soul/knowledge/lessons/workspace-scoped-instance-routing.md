---
type: Lesson
title: Scope instance-name endpoints by workspace ID
description: When multiple watched workspaces can contain same-named instances, instance-name APIs must forward ?ws= and findInstance(name, wsId) must fail closed inside that workspace rather than falling back to the first match.
tags: [oas-web, multi-workspace, routing, safety]
timestamp: 2026-07-22
---

# The trap

Multiple watched workspaces can have live instances with the same name. The
legacy `findInstance(name)` behavior returned the first match across all
workspace snapshots; if an instance-addressed request omitted workspace scope,
a request such as `/api/keys` could target the wrong same-named instance.

# Rule

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

# Related concepts

- [Multi-workspace support](/architecture/multi-workspace-switcher.md)
- [oas-web architecture](/architecture/oas-web-architecture.md)
- [Raw key passthrough and the loopback Host/Origin guards](/architecture/raw-key-passthrough-and-host-guard.md)
- [Guard file-serving paths by realpathing requests and roots](/lessons/file-endpoint-realpath-guard.md)
