---
type: Lesson
title: Resolve team-scoped roster relations with composite full-scope identity
description: "Team-scoped roster views must key instances by a composite identity and resolve relation names against the full roster, not filtered groups."
tags:
  - desktop
  - active-overview
  - identity
  - team-scope
  - clusters
timestamp: 2026-07-25T18:00:00Z
---

# Lesson

In team-scoped roster panels, bare `instance` names are display labels, not identity keys. Duplicate instance names across agent directories, team repositories, or workspaces are legal, so maps, union-find indexes, selection state, popovers, edge stores, offsets, and DOM nodes keyed only by name can drop a live instance or falsely merge clusters.

Use a composite key that includes the name plus a stable discriminator such as home, repository, or workspace, while keeping the display label separate. This strengthens [Agent-centered desktop information architecture](/decisions/agent-centered-desktop-information-architecture.md)'s rule that workspace, instance, and artifact identity remain visible together, and complements [Keep cluster identity keys separate from rendered labels](/lessons/cluster-identity-internal-key-vs-label.md).

# Relation resolution scope

Relation fields such as `parentInstance` and `siblingInstance` can carry bare names. Resolve them with explicit rules against the widest available roster. Build the name-resolution index once at that full scope and pass it into downstream cluster, layout, and edge stages; do not rebuild it from a filtered subgroup, because a globally ambiguous name can look unique inside one cluster and resurrect an edge that grouping correctly dropped as unsafe.

# Determinism check

When sorting items with legal duplicate display names, use the composite identity key as the final tie-breaker; otherwise positions can swap with input order. Regression tests for this class should fail when the composite/full-scope fix is reverted.
