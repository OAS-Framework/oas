---
type: Lesson
title: Team scope and cross-repo spawn are CLI root resolution, not kernel changes
description: The team block declares the deployment boundary and teamAgentRoots scans it, but cross-repo spawn/retire landed almost entirely in bin/oas.mjs as a resolution-layer fallback because spawnInstance already homes under the agent's own dir — and instance names are only unique per agent dir, so instance lookups must stay local-first.
tags: [team, cross-repo, spawn, teamAgentRoots, findTeamAgent, cli]
timestamp: 2026-07-21
---

# Team as a config entity

A `team:` block (name + optional provider id) at any config scope declares
the deployment boundary; **closest declaration wins** and the declaring
scope becomes `team.scope`. `teamAgentRoots(teamScope)` is a deterministic
shallow scan: the scope's own `agents/` plus each direct child directory's
`agents/` (member repos). An explicit `team.repos:` list was proposed and
**rejected** — the workspace directory tree IS the member list; the scan is
the discovery mechanism.

# Cross-repo spawn (v0.12.0) — where the change actually lives

Key insight: `spawnInstance(root, agent, o)` already homes the instance under
`agent._dir` and resolves config from the work repo's absolute path — so
cross-repo spawn needed **no kernel spawn changes**, only resolution in
`spawnCmd`/`retireCmd` (bin/oas.mjs):

- `oas spawn <soul>`: local agent first; if not found and a `team:` resolves,
  `findTeamAgent` searches team roots — a **unique** remote match redirects
  the root (with a printed notice), multiple matches error with `--dir`
  guidance, local souls always shadow remote ones.
- The default repo of a remote soul must derive from **the owning root's
  workspace** (`defaultRepo(workspaceOf(foundRoot))`), not the calling repo —
  the original implementation pointed the work tree at the caller's repo.
- The remote root's config chain resolves the spawn (repo B's capabilities
  and injections apply, not the caller's).

# The instance-name lesson

**Instance names are only unique per agent dir** (they're `<agent>-N` under
`<agent>/instances/`). So `oas retire <instance>` and instance lookups must
be **local-first**, with team-wide fallback (`findTeamInstance`) only when
nothing matches locally — this was caught by test, not by design.

Reference decision: `agents/oas-expert/soul/knowledge/decisions/team-as-config-entity.md`.
