---
type: Concept
title: Work modes and the workspace mode boundary requirement
description: Spawn supports worktree, checkout, attached, and workspace modes with packaged briefings as the contract; workspace mode points ./work at the team scope, requires a declared boundary to resolve, and records no branch.
tags: [work-modes, workspace, resolveWorkMode, spawn]
timestamp: 2026-07-21
---

# The four modes

`spawnInstance` validates `work` ∈ {worktree, checkout, attached, workspace}.
Each mode's instruction briefing is the **packaged** inject
(`injects/work-<mode>.md`) — work-mode injection overrides were removed; the
only config knob is `work-modes.<mode>.setup:` (an env-bootstrap script run in
new worktrees). `resolveWorkMode` returns `{ inject, setup }` and rejects any
other key under `work-modes.<mode>` with a migration error.

- **worktree**: own branch in a git worktree.
- **checkout**: `./work` symlinks the shared repo checkout (never switch
  branches; the human's tree).
- **attached**: `./work` is another instance's work tree; spawn REQUIRES
  `workDir` (soul-default attached is for service agents).
- **workspace** (v0.14.0): `./work` symlinks the **team scope** — for free
  agents (coordinators) that read all member repos but never edit them.

# Workspace-mode specifics

- **Boundary requirement**: the mode needs a declared boundary — it resolves
  `./work` to the team scope, falling back to the config workspace scope, and
  errors if neither resolves. You cannot workspace-spawn without a `team:` (or
  workspace config) in the chain.
- **No branch**: branch is recorded as `-` (no repo identity); retire never
  touches the tree (symlink semantics, like checkout).
- Enforcement is **instruction-only** (the packaged briefing forbids editing
  or git operations in member repos), consistent with the other modes.
- Knowledge consequence: the soul lives in a committed home repo, so OKF
  harvest for workspace instances delivers promotions as PRs to that repo —
  the "commit in your work tree" protocol is wrong there (oas-okf 1.1.0 varies
  its brief by mode).

Reference decision: `agents/oas-expert/soul/knowledge/decisions/workspace-work-mode.md`.
