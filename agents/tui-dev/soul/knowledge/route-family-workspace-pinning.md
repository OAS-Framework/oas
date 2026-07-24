---
type: Lesson
title: Scope classification by route family, not endpoint enumeration
description: Desktop proxy workspace pinning must classify whole instance-addressed route families instead of enumerating individual endpoints so new routes fail safe rather than silently unpinned.
tags: [desktop, workspace, security, proxy]
timestamp: 2026-07-23
---

The desktop proxy's workspace pinning should classify instance-addressed route
families, not grow an endpoint-by-endpoint allowlist. A review of the merged
workspace-pinning state found that pinning had been added for `/api/panel`,
`/api/agents`, `/api/brain`, and `/api/diff`, while `/api/session`,
`/api/keys`, `/api/interrupt`, `/api/jira`, and `/api/chat` were still
unpinned even though the server's `findInstance(name, wsId)` resolves the
whole `/api/<verb>/<instance>` family per workspace.

When the scoping property holds for a route family by construction
(instance-addressed implies workspace-resolved), encode the family in one
classifier, e.g. `/^\/api\/(brain|diff|session|keys|interrupt|jira|chat)\//`.
Do not append `startsWith()` clauses as endpoints happen to be discovered:
future endpoints, including desktop-terminal paths through session or keys
routes, should fall into the safe scoped path automatically.

This supersedes the earlier rule in [Desktop shell view integration lessons](desktop-shell-view-integration-lessons.md)
that coupled the proxy pin list to every endpoint a view happened to query.
