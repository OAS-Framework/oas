---
type: Decision
title: Spawn lineage is explicit-only and deployment-local
description: Lineage comes only from an explicit child/sibling/parent relation (with --parent as child sugar) or attached-mode owner binding; ambient env is ignored and cross-deployment spawns stay operator-origin.
tags: [spawn, lineage, kernel, cli, cross-deployment]
timestamp: 2026-07-26
---

# Decision

Non-attached manual spawns with no explicit relation land top-level
(`spawnOrigin: operator`, no lineage fields). `lib/core.mjs` `spawnInstance`
never reads `OAS_INSTANCE` or
`PI_AGENT_INSTANCE` as relation intent. Lineage sources are:

1. An explicit relation inside the target deployment:
   - `child` records the anchor as the new instance's `parentInstance`;
   - non-root `sibling` shares the anchor's `parentInstance`, while root sibling
     records `siblingInstance` instead;
   - `parent` gives the new instance the anchor's old parent/sibling slot and
     re-points the anchor beneath it;
   - `unrelated` records no lineage. `o.parent` / CLI `--parent` is child sugar.
2. Attached-mode binding: a verified owner of the shared work tree becomes the
   new instance's `parentInstance`, even though auto-binding does not store a
   `relation` value. Verify by scanning candidate homes path-first across local
   and team scope, matching symlinked checkout `work` paths by lexical parent
   relation and real work directories by realpath equality, then accepting the
   recordable name only if it resolves back to the matched home from the
   attached instance's context. A legitimate non-instance work tree must name
   its owner with `--parent` or the equivalent explicit child relation.
3. Otherwise: operator origin, top-level.

Attached mode is a binding lineage source, not a negatable default: relation
flags that would make the attached agent unrelated, sibling, or parent to its
work-tree owner are rejected at both CLI and kernel boundaries. See
[attached-spawns-child-of-work-owner](/decisions/attached-spawns-child-of-work-owner.md)
and [path-first resolution](/lessons/path-first-resolution-round-trip.md).

Agent-driven spawn surfaces that target the same deployment express their
final topology explicitly: `oas-okf harvest` passes its owner as a child parent;
attached post-commit reviewers inherit child-of-work-owner automatically; and a
non-attached maintainer spawned to oversee the caller uses
`--relation parent --relative-to "$OAS_INSTANCE"`. The oas skill and canonical
soul policies document these rules.

# Cross-deployment boundary

`parentInstance` only makes sense within the target deployment's agents roots
(local root plus team scope). Cross-deployment helpers that spawn into a foreign
agents root, such as the oas-support `--dir <repo>` pattern, must leave lineage
operator-origin instead of passing `--parent "$OAS_INSTANCE"`.

Even if the caller's home could prove that a foreign parent exists, recording it
in the target deployment would create a dangling parent: target hierarchy
surfaces cannot resolve instances outside their deployment. The correct
top-level fallback avoids misattribution-shaped metadata.

When changing spawn semantics or relation policy again, migrate every
agent-facing spawn recipe in the same change, not just kernel docs. Grep
Markdown for `oas spawn` across soul skills, injections, and documentation so
live agents do not keep following stale recipes.

# Why not "env only when alive"

Aliveness checks cannot distinguish a human terminal inside an agent's tmux
window from the agent itself — the misattribution case is an alive instance.
Only explicit intent is safe.
