---
type: Lesson
title: Team-boundary workspace discovery — prune by name and by nested team declaration
description: discoverWorkspaceScopes walks the boundary depth-first in sorted path order, pruning fixed directory names (.git, node_modules, vendor, venvs, .agents, local-agents), instances/ dirs that sit next to a soul/, and any child whose oas-config.yaml declares its own team:, which makes nested team boundaries self-owned reconciliation units without any registry.
tags: [install, reconciliation, team, discovery]
timestamp: 2026-07-26
---

# Lesson

Bare `oas install` reconciliation scans descendants from the `team:` boundary
with a plain sorted `readdir` depth-first walk. Pruning is threefold:

- **name-based**: skip `.git`, `node_modules`, `vendor`, `.venv`, `venv`,
  `bower_components`, `.direnv`, `.agents` (generated stores never hold
  workspace scopes), and `local-agents` (runtime souls).
- **structure-based**: an `instances/` directory whose sibling is `soul/` is an
  agent-home tree, with worktrees under it, so skip it.
- **declaration-based**: a child directory whose own `oas-config.yaml` declares
  `team:` is a nested team boundary. Do not include it and do not descend into
  it; it reconciles itself.

Symlinked directories are skipped entirely to avoid cycles and scope escapes.
The boundary prints before any restore, network, or host work; the test asserts
ordering with `indexOf`, which is cheap and robust.

Non-team scopes keep chain-only restore unless `--recursive` is passed.
`restoreCapabilities(scope)` walks lockfiles upward, so per-scope reports must
be filtered to `r.level === scope`; otherwise an ancestor's graph can be
reported or restored once for each descendant scope.

This extends the team-as-config discovery posture captured in
[team-scope-and-cross-repo-spawn](/lessons/team-scope-and-cross-repo-spawn.md):
the workspace tree is the registry, and nested `team:` declarations mark
self-owned reconciliation units.
