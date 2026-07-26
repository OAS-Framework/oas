---
type: Concept
title: Spawn relations map to sparse lineage fields
description: oas spawn relations use sparse parentInstance/siblingInstance fields, attached work mode forces child-of-work-owner, and retireInstance splices complete surviving lineage for links that point at a retiree.
tags: [spawn, lineage, relations, kernel, cli]
timestamp: 2026-07-25
---

# Shape

`oas spawn --relation child|sibling|parent|unrelated --relative-to <instance>`
records only the lineage fields that consumers need. `--parent <instance>` is
sugar for the child relation.

- **Child** records the anchor as `parentInstance` on the new instance.
- **Sibling** does not add a new tree shape when the anchor already has a
  parent: the new instance shares the anchor's `parentInstance`. When the
  anchor is a root, the new instance records `siblingInstance: <anchor>` so the
  root-level cluster stays connected without mutating the anchor. Hierarchy
  consumers treat connected components over `parentInstance` and
  `siblingInstance` edges as sibling clusters.
- **Parent** is the only relation that mutates another instance's metadata: the
  anchor's `instance.json` is re-pointed to `parentInstance = <new instance>`.
  The new parent inherits the anchor's old `parentInstance` and `siblingInstance`
  so it takes the anchor's previous slot in the tree. Delete the anchor's old
  `siblingInstance`; the new parent carries that cluster edge and duplicate
  edges confuse traversal.
- **Unrelated** is normalized away before recording. Absent lineage fields mean
  unrelated; consumers should never see `relation: "unrelated"` as stored
  metadata. During option parsing an explicit unrelated request can survive long
  enough to bypass ordinary non-attached relation defaults, but it cannot
  suppress attached-mode parentage.

# Attached work mode

Attached work mode owns the lineage decision: an attached spawn records the
shared work-tree owner as `parentInstance`. Relation flags that contradict that
child-of-owner shape are invalid (`E_BAD_ARGS` at the CLI and a kernel throw for
programmatic callers). Only an explicit redundant child-of-owner request is
accepted, because capability hooks may pass the parent explicitly.

The work-tree owner is identity-sensitive. Resolve it path-first over known
candidate homes in the local root and team scope. Symlinked checkout-mode
`work` directories all realpath to the same shared repository, so match those
by lexical parent relation; match real work directories by realpath equality.
Only record a candidate name after resolving that name from the attached
instance's context lands back on the same home. Path shape alone is not proof,
and a same-named local instance that breaks the round trip is ambiguous.
Legitimate non-instance integration work trees need explicit ownership
(`--parent`) only when the path matches no known instance work. The binding
policy is recorded in
[attached-spawns-child-of-work-owner](/decisions/attached-spawns-child-of-work-owner.md)
and [path-first resolution](/lessons/path-first-resolution-round-trip.md).

# Retirement repair

Relations that write cross-instance links must specify what happens when either
side retires. `retireInstance` splices a retiree out of the graph: any instance
whose `parentInstance` or `siblingInstance` names the retiree inherits the
retiree's complete surviving lineage, regardless of which edge type pointed at
the retiree. Same-type substitution is not enough: a parent-linked child still
needs a retiree's surviving sibling edge, and a sibling-linked peer still needs a
retiree's surviving parent edge. If the retiree had no surviving links, affected
instances become roots; dangling sibling links are dropped. The result includes
`relinked[]` so callers can report which instances were repaired.

This repair is required for parent relation: an ephemeral parent retiring should
hand anchored instances back to the displaced parent instead of leaving
`parentInstance` pointing at a missing instance. Because spawn can resolve
anchors across member repositories, retirement repair must scan every
`teamAgentRoots` root, not only the retiree's local repo. A bare lineage value is
not enough to identify the retiree: resolve it from the referrer's agents root
using the same local-first, then team-scope precedence spawn uses, and splice
only when that resolved home realpath-matches the retiree's home. Run the splice
before deleting the retiree home, or this proof is impossible. Local-only scopes
may lack an `agents/` directory, so failed realpath checks must fall back to
`resolve(root)` rather than dropping the root. See the
[nonexistent roots lesson](/lessons/team-agent-roots-nonexistent-roots.md), the broader
[relation-policy lesson](/lessons/relation-policy-migration-and-retire-splice.md),
and [identity lesson](/lessons/names-are-not-identity.md).

# Accepted concurrency limitations

The retained architecture deliberately uses sparse per-instance JSON rather
than a deployment transaction/journal subsystem. The human and maintainer
accepted two limitations for this feature:

- two concurrent `parent` spawns against the same anchor are not serialized;
  both can read the same old slot and the last anchor rewrite wins, so callers
  should avoid issuing competing parent spawns for one anchor;
- retirement repair updates affected instance files one by one and is not a
  crash-atomic multi-file transaction; retry/manual reconciliation may be
  needed after an I/O failure partway through a splice.

These are consciously accepted trade-offs, not pending implementation. Do not
reintroduce lineage journals, leases, or a filesystem transaction engine
without a new human architecture decision.

# Validation boundary

Relation validation intentionally happens in both surfaces: the CLI returns
stable pre-scaffold errors such as `E_BAD_ARGS` or `E_RELATIVE_NOT_FOUND`, while
the kernel still throws for programmatic callers. Sibling and parent relations
must read the anchor's `instance.json` in the kernel; fail before scaffolding and
before lifecycle hooks if it is missing or unreadable. Re-read in the kernel even
when the CLI already checked, because anchor state can change between the CLI
check and the kernel read.

Anchor resolution uses the same ambiguity posture as other bare-name lineage
edges: enumerate all candidates, require an explicit `--relative-root`/
`o.relativeRoot` qualifier when multiple homes match, and still verify the
stored bare name round-trips from the edge consumer's root. Enumeration must
surface intra-root duplicate names too, because no root qualifier can split two
same-named homes under one agents root. Parent relations must also check the
reverse edge they write on the anchor before scaffolding.

Sibling and parent relations that copy an anchor's existing `parentInstance` or
`siblingInstance` onto the new instance must validate each copied name from both
the anchor's root and the new instance's root. Store it only when both roots
resolve it to the same canonical home, or when it is dangling from both roots;
reject if the name resolves differently across those contexts. See the
[lineage ambiguity lesson](/lessons/lineage-edge-ambiguity-posture.md).

This extends the explicit-lineage rule in
[spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md): the
caller chooses the relation, but the recorded metadata stays sparse and local to
the affected instances. The no-side-effects validation lesson is captured in
[kernel-validation-before-side-effects](/lessons/kernel-validation-before-side-effects.md).
