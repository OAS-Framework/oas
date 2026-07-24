---
type: Lesson
title: Scope snapshot lookups to the caller's workspace
description: When an endpoint has resolved a workspace, subsequent roster-snapshot lookups must pass that workspace id; unscoped first-match lookup can mislabel same-named instances from another workspace.
tags: [oas-web, brain, workspace-scope, snapshots]
timestamp: 2026-07-22
---

# Trap

`findInstance(name)` with first-match-anywhere semantics is wrong after a
caller has already resolved a workspace. Instance names can repeat across
workspaces, so a lookup that searches every workspace can borrow state from a
same-named instance elsewhere.

The `/api/brain` running flag hit this shape: a stopped instance in the selected
workspace was marked `running: true` because another workspace had an instance
with the same name in RUNNING state, which offered a terminal action that could
not resolve locally.

# Rule

Once an endpoint resolves a workspace, every subsequent roster-snapshot lookup
must carry that workspace scope. Use a scoped lookup such as
`findInstance(name, wsId)` for workspace-aware endpoints; leave unscoped lookup
only for name-only entry points such as `/api/session/<instance>` that have no
workspace selector.

# Regression shape

Exercise the lookup against a fabricated two-workspace snapshot with the same
instance name in both workspaces: stopped in workspace A and running in workspace
B. Assert that scoped lookup returns the truth for each workspace and does not
leak B's running state into A.

# Related concepts

- [Agent brain endpoint and desktop brain view](/architecture/agent-brain-endpoint-and-view.md)
- [Keep roster collection out of the serving process](/lessons/snapshot-collection-off-thread.md)
