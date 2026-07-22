---
type: Concept
title: Multi-workspace support — repeatable --dir and the workspace switcher
description: The server accepts a repeatable --dir flag whose contexts each resolve to their team/deployment scope (duplicates collapse), and the UI shows a workspace dropdown only when more than one workspace is watched, while instance-addressed endpoints must carry the selected workspace because instance names are workspace-local.
tags: [oas-web, workspace, multi-workspace, roster, team]
timestamp: 2026-07-22
---

# Server side (oas-web.mjs)

- `--dir` is **repeatable**: `oas web start --dir ~/lfx --dir ~/oas`. No
  `--dir` means cwd.
- Each context resolves through `core.resolveOasConfig` to its **team scope**
  (when a `team:` block is declared) or config scope; `teamAgentRoots(scope)`
  yields the agents roots. Duplicates collapse by scope id in `workspaces()`.
- `panelData(wsId)` aggregates `collectControlPane(root)` over the selected
  workspace's roots; a broken root is swallowed (one bad root must not hide
  the rest). Running instances sort first.
- `findInstance(name, wsId)` is the safe path for instance-addressed endpoints:
  with `wsId` it searches only that workspace and strict-misses unknown
  workspaces. The unscoped `findInstance(name)` fallback searches all
  workspaces and is ambiguous when names collide, so view code must include
  `?ws=<id>` on per-instance requests; see
  [the workspace-scoping lesson](/lessons/workspace-scoped-instance-requests.md).

# UI side (panel.html)

- A workspace dropdown appears in the header **only when** the server watches
  more than one workspace (single-workspace setups stay clean). Entries show
  `name · team`. Selection persists across reloads.
- Switching swaps the roster and clears the session pane/caches (this
  intersects the stale-response guards).
- The selected workspace is routing state, not just display state: shared view
  helpers should append `?ws=<id>` to interrupt, chat, Jira, session, and key
  requests instead of hand-building per-instance paths.

# Mental model

The dropdown is a **deployment switcher, not a repo filter** — within one
workspace the sidebar already groups instances by repo. This keeps the UI
aligned with how OAS scopes things: workspace = team boundary.
