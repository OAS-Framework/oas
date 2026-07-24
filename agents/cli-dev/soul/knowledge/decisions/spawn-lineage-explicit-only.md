---
type: Decision
title: Spawn lineage is explicit-only and deployment-local
description: parentInstance now comes only from an explicit --parent/o.parent inside the target deployment or the attached-mode workDir-owner fallback; env vars are never consulted, and cross-deployment spawns stay operator-origin.
tags: [spawn, lineage, kernel, cli, cross-deployment]
timestamp: 2026-07-24
---

# Decision

Manual spawns land top-level (`spawnOrigin: operator`, no `parentInstance`)
unless a parent is explicitly given. `lib/core.mjs` `spawnInstance` no longer
reads `OAS_INSTANCE` or `PI_AGENT_INSTANCE` for lineage. Parentage sources, in
order:

1. `o.parent` (CLI `--parent <instance>`, validated to exist inside the target
   deployment's local root or team scope before scaffolding).
2. Attached-mode fallback: owner of the shared work tree (the `workDir`'s
   `<home>/work` parent dir name). Attached service agents genuinely nest.
3. Otherwise: operator origin, top-level.

Agent-driven spawn surfaces that target the same deployment pass explicit
parentage: `oas-okf harvest` spawns pass `parent: inst`; the review injection's
maintainer spawn example uses `--parent "$OAS_INSTANCE"`; the oas skill
documents the rule.

# Cross-deployment boundary

`parentInstance` only makes sense within the target deployment's agents roots
(local root plus team scope). Cross-deployment helpers that spawn into a foreign
agents root, such as the oas-support `--dir <repo>` pattern, must leave lineage
operator-origin instead of passing `--parent "$OAS_INSTANCE"`.

Even if the caller's home could prove that a foreign parent exists, recording it
in the target deployment would create a dangling parent: target hierarchy
surfaces cannot resolve instances outside their deployment. The correct
top-level fallback avoids misattribution-shaped metadata.

When changing spawn semantics again, migrate every agent-facing spawn recipe,
not just kernel docs. Grep Markdown for `oas spawn` across soul skills,
injections, and documentation so live agents do not keep following stale
recipes.

# Why not "env only when alive"

Aliveness checks cannot distinguish a human terminal inside an agent's tmux
window from the agent itself — the misattribution case is an alive instance.
Only explicit intent is safe.
