---
type: Decision
title: Team as a first-class config entity
status: accepted
description: A team block (name + optional provider id) at any config scope declares the deployment boundary — closest wins; it drives instance identity, cross-repo agent discovery via oas status --team, and the aweb integration's team join, with the instance name as the discoverable alias.
tags: [config, team, aweb, discovery, messaging]
timestamp: 2026-07-14
---

Decided with the founder, 2026-07-14, motivated by LFX-shaped deployments: a
workspace (e.g. `~/lfx`) with agents defined both at the workspace level and
inside member repos (self-serve etc.) needs (a) agents to know what team they
belong to from config, not from whichever `.aw` directory is found, and (b)
cross-repo agent discovery.

# Shape

```yaml
# workspace-scope oas-config.yaml
team:
  name: lfx-engineering
  # id: lfx-engineering:example.com   # explicit provider team id
```

`name:` required; `id:` optional (for aweb, the canonical
`<name>:<namespace>` team id). The **closest scope declaring `team:` is the
deployment boundary** — every repo under it resolves the same team. This
formalizes the boundary the aweb hook previously guessed at via bounded `.aw`
discovery.

# What hangs off it

1. **Identity**: `resolveOasConfig` exposes `team {name, id, scope}`;
   instances record it in `instance.json` and get a TASK.md line ("Team: …,
   see teammates with `oas status --team`"). Hooks receive
   `OAS_TEAM_NAME`/`OAS_TEAM_ID`/`OAS_TEAM_SCOPE`.
2. **Discovery**: `teamAgentRoots(scope)` = the scope's own `agents/` plus
   each direct child directory's `agents/` (deterministic shallow scan; an
   explicit `team.repos:` list was considered and deferred until scanning
   proves insufficient). `oas status --team` renders the whole-deployment
   roster; doctor shows the resolved team.
3. **Messaging (aweb)**: the spawn hook's team preference is now config
   `id` > config `name` > legacy `settings.team` pin > active team at the
   aweb root. A bare name (no `:namespace`) is resolved against the root's
   memberships — unique match wins, ambiguity/no-match warns with guidance
   to set `team.id`. The hook keeps its invariants: always `--team-id`
   explicit at invite, verify the joined cert, never inherit the ambient
   active team. **The instance name is the discoverable alias** (`aw team
   join --name <instance>`), unchanged and now documented as contract.

# Rejected / deferred

- Team declarations per-repo overriding the workspace: allowed by
  closest-wins mechanics (a repo can belong to a different team), but the
  normal pattern is one workspace-scope declaration.
- Cross-repo *spawning* (spawn a sibling repo's soul from another repo):
  deferred — homing and work-mode questions deserve their own decision.
- `team.repos:` explicit member list: deferred, scan-of-direct-children is
  deterministic and covers the workspace-of-repos pattern.
