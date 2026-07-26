---
type: Decision
title: Spawn relations use sparse live lineage, not a transaction journal
description: OAS records explicit child, sibling, parent, or unrelated spawn relations as sparse current-state lineage, fails closed on ambiguous names, and accepts bounded non-atomic concurrency tradeoffs rather than adding a journal or lease subsystem.
status: accepted
tags: [spawn, relations, lineage, kernel, desktop, concurrency]
timestamp: 2026-07-26
---

# Context

The original OAS constellation stored an optional `parentInstance` so operators
could read current spawn lineage without a daemon or event log. Coordinators,
developers, reviewers, and maintainers also need to express peers and temporary
overseers. The Desktop product needs those relations for cluster grouping, but
the kernel must remain runtime-neutral, dependency-free, and truthful from
plain instance files.

Instance names are not globally unique: the same name can exist under different
agent directories or team repositories. A richer relation surface therefore
cannot safely turn bare names into identity without qualification and
round-trip checks.

# Decision

`oas spawn` accepts an explicit relation between the new instance and an
existing anchor:

- `child`: the new instance records the anchor as `parentInstance`;
- `sibling`: it shares the anchor's parent, or records `siblingInstance` when
  both are roots;
- `parent`: the new instance inherits the anchor's old lineage slot and the
  anchor is re-pointed to the new parent;
- `unrelated`: no edge, which is also the default.

`--parent <instance>` remains child-relation sugar. The recorded shape stays
sparse: `parentInstance`, optional root-peer `siblingInstance`, and informative
`relation`/`relativeTo` fields. Relations form connected components for UI
clusters; they do not create named cluster entities or historical records.

Attached work mode is always child-of-work-tree-owner. Ownership is resolved by
canonical path and accepted only when the recorded name resolves back to the
same home. Other relation choices are contradictory and rejected.

Because names can collide, relation creation enumerates candidates, supports an
agents-root qualifier, rejects intra-root ambiguity, and verifies every stored
or inherited bare-name edge from each context that will consume it. Desktop
uses composite home/root identity for nodes and privileged instance routes; an
ambiguous bare-name request fails closed rather than choosing the first match.

Retirement splices links that resolve to the retiree so affected instances
inherit its surviving parent and sibling slot. This keeps ordinary temporary
parent/reviewer lifecycles readable without ghost nodes.

# Accepted limitations

The human explicitly declined expanding this feature into a lineage journal,
lease/reservation service, or multi-file transaction engine. Two limitations
are accepted:

1. Concurrent parent-relation spawns against one anchor can both succeed; the
   last anchor write wins, so the other new parent's metadata may describe a
   relation that is no longer represented by the anchor.
2. Retirement repairs multiple orphan files sequentially. A mid-splice write
   failure can leave a partially repaired graph.

These cases require concurrent mutation of the same anchor or a write failure
partway through repair. They are not hidden guarantees: OAS provides a
lightweight live-current-state graph, not database-grade lineage
serializability. Revisit only if observed deployment pressure justifies a
separate persistence/coordination subsystem.

# Desktop and release consequence

Desktop mutates only through the installed CLI. Older Desktop API v1 CLIs
ignore unknown spawn flags, so related spawn controls must fail closed below
the first release containing both relation flags and agents-root
qualification. That synchronized release is **v0.18.6**; the Desktop relation
capability floor must remain `0.18.6` for this delivery.

This extends the live-only, no-journal lineage posture preserved from the
historical [Control Pane decision](/decisions/control-pane-live-standalone-tui.md)
and keeps the installed-CLI boundary from the
[Desktop succession decision](/decisions/desktop-panel-succession.md).
