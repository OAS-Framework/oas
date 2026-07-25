---
type: Lesson
title: Graph code over roster instances must key by composite identity, not bare name
description: Instance names are only unique within one agents root, so renderer graph and cluster code must key nodes by canonical home or agentsRoot plus name, not bare instance name.
tags: [desktop, clusters, identity, agent-relations]
timestamp: 2026-07-25
---

Merged-state review finding on feature/agent-relations (f7c5769):
`clusterInstances` used `new Map(instances.map((i) => [i.instance, i]))`, so a duplicate instance name from another agents root or team repo silently replaced the first entry and a live instance vanished from the sidebar.

# Rule

- **Node key** = `instanceId(i)`: canonical `home` path when present; `agentsRoot + "\0" + name` fallback; bare name only when the roster carries neither. `renderer/instance-tree.mjs` exports this as the one shared helper; other views should adopt it rather than re-derive it.
- **Relation edges carry names** from `instance.json` lineage, scoped to one deployment. Resolve a same-`agentsRoot` candidate first; a globally unique name may resolve cross-root; an ambiguous name with no same-root candidate resolves to nothing.
- Fail safe means two separate clusters, never a wrong merge and never a hidden node.

This mirrors the existing [workspace-scoped instance routing](/lessons/workspace-scoped-instance-routing.md) lesson: names are context-relative identifiers everywhere, not global keys.
