---
type: Concept
title: Multi-workspace support — repeatable --dir and the workspace switcher
description: The server accepts a repeatable --dir flag whose contexts each resolve to their team/deployment scope (duplicates collapse), the UI shows a workspace dropdown only when more than one workspace is watched, and instance-name APIs pass ?ws= so same-named instances resolve inside the selected workspace.
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
- `findInstance(name, wsId)` reads the workspace snapshot. With a `wsId`, it
  searches only that workspace; an unknown workspace or missing instance returns
  no match (404 at the route), with no fallback to another workspace. Without a
  `wsId`, the legacy first-match-across-all-workspaces lookup remains.
- Instance-name routes (`session`, `keys`, `interrupt`, `jira`, `chat`, and
  `diff`) forward the selected workspace as `?ws=` so same-named instances do
  not cross wires. `/api/file` intentionally stays cross-workspace because it is
  absolute-path based and guarded by realpath containment, not instance-name
  routing. See [the workspace-scoping lesson](/lessons/workspace-scoped-instance-routing.md).

# UI side (panel.html)

- A workspace dropdown appears in the header **only when** the server watches
  more than one workspace (single-workspace setups stay clean). Entries show
  `name · team`. Selection persists across reloads.
- Switching swaps the roster and clears the session pane/caches (this
  intersects the stale-response guards). Instance-addressed calls include the
  selected workspace id as `?ws=` so the server can resolve duplicate instance
  names safely.

# Mental model

The dropdown is a **deployment switcher, not a repo filter** — within one
workspace the sidebar already groups instances by repo. This keeps the UI
aligned with how OAS scopes things: workspace = team boundary.
