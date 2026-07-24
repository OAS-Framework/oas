---
type: Decision
title: Spawn lineage is explicit-only — env sniffing removed
description: parentInstance now comes only from an explicit --parent/o.parent or the attached-mode workDir-owner fallback; OAS_INSTANCE/PI_AGENT_INSTANCE env vars are never consulted, because env inheritance is not evidence of intent.
tags: [spawn, lineage, kernel, cli]
timestamp: 2026-07-24
---

# Decision

Manual spawns land top-level (`spawnOrigin: operator`, no `parentInstance`)
unless a parent is explicitly given. `lib/core.mjs` `spawnInstance` no longer
reads `OAS_INSTANCE` or `PI_AGENT_INSTANCE` for lineage. Parentage sources, in
order:

1. `o.parent` (CLI `--parent <instance>`, validated to exist locally or via
   `findTeamInstance` before scaffolding).
2. Attached-mode fallback: owner of the shared work tree (the `workDir`'s
   `<home>/work` parent dir name). Attached service agents genuinely nest.
3. Otherwise: operator origin, top-level.

Agent-driven spawn surfaces pass explicit parentage: `oas-okf harvest` spawns
pass `parent: inst`; the review injection's maintainer spawn example uses
`--parent "$OAS_INSTANCE"`; the oas skill documents the rule.

# Why not "env only when alive"

Aliveness checks cannot distinguish a human terminal inside an agent's tmux
window from the agent itself — the misattribution case is an alive instance.
Only explicit intent is safe.
