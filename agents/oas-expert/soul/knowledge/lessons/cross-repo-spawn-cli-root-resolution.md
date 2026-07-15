---
type: Lesson
title: Cross-repo spawn belongs in CLI root resolution, not the kernel
description: Team-scope cross-repo spawn/retire belongs in CLI-level root selection; keep spawnInstance/retireInstance untouched so homing follows the soul's own repo.
tags: [team, spawn, architecture, kernel]
timestamp: 2026-07-15
---

Related decision: [Team as a first-class config entity](/decisions/team-as-config-entity.md).

When adding cross-repo spawn (spawn a sibling repo's soul from another repo
in the same team scope), the clean cut was: the kernel's
`spawnInstance(root, agent, ...)` already does the right thing for *any*
root — so cross-repo support is just picking the right root before calling
it. Two small core helpers (`findTeamAgent`, `findTeamInstance`) walk
`teamAgentRoots(team.scope)`; the CLI redirects `root` on a unique remote
match, errors on ambiguity, and lets a local soul always shadow the team
lookup. Homing, work tree, and config chain all follow the owning repo
automatically because they derive from `agent._dir` and `agent.repo`.

Gotcha found by test: instance names are only unique per-agent-dir, so a
cross-repo retire must prefer the local root first (same order as spawn's
shadowing) — two repos can both have `api-dev-1`.
