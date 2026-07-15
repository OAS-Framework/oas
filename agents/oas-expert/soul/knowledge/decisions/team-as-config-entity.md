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
3. **Messaging (aweb)**: the spawn hook's team preference is config `id` >
   config `name` > active team at the aweb root (the legacy `settings.team`
   pin was dropped — no legacy care on 0.x). A bare name (no `:namespace`) is resolved against the root's
   memberships — unique match wins, ambiguity/no-match warns with guidance
   to set `team.id`. The hook keeps its invariants: always `--team-id`
   explicit at invite, verify the joined cert, never inherit the ambient
   active team. **The instance name is the discoverable alias** (`aw team
   join --name <instance>`), unchanged and now documented as contract.

# Cross-machine discovery

`oas status --team` is the *local* view (this machine's filesystem). The
cross-machine view rides the messaging layer: every OAS-spawned instance
joins the aweb team with alias = instance name, so the team's certificate
roster doubles as the network directory of live instances (plus humans).
`oas aweb roster` (a trusted operational command on the oas.aweb package,
v1.1.0) lists it via `aw id team members` from the resolved team; the aweb
injection teaches both commands. Liveness across machines is
eventually-consistent — retire self-deletes the workspace, but a crashed
machine's records linger until the server marks them stale.

# Onboarding and degradation

`oas aweb setup` (operational command, oas.aweb v1.2.0) is the guided,
idempotent onboarding: it checks in order (1) config `team:` declared, (2)
`aw` CLI present, (3) aweb workspace at the team scope (`aw init` — including
first-ever hosted account creation), (4) membership matching the configured
team (`aw team create` / `aw team join <token>`), printing exactly the one
next step at each stage. The aweb root candidate list now puts the declared
team scope (OAS_TEAM_SCOPE) first. When `aw` is missing, spawn degrades
gracefully — the hook warns "messaging disabled for this instance" with the
install pointer, never blocks; roster/setup exit 1 with the same pointer.

`oas update [--check|--yes]` checks npm for the latest kernel+bridge (they
publish in lockstep from one tag), shows the steps, executes on confirmation,
and directs the user to `oas doctor` afterwards — migration knowledge ships
in the new kernel (pointed config-spelling errors, version-skew warning in
doctor), not in a skill that could go stale.

# Rejected / deferred

- Team declarations per-repo overriding the workspace: allowed by
  closest-wins mechanics (a repo can belong to a different team), but the
  normal pattern is one workspace-scope declaration.
- Cross-repo *spawning* (spawn a sibling repo's soul from another repo):
  deferred — homing and work-mode questions deserve their own decision.
- `team.repos:` explicit member list: deferred, scan-of-direct-children is
  deterministic and covers the workspace-of-repos pattern.
