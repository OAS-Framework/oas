---
type: Lesson
title: Lineage edges need ambiguity posture in both directions
description: Any operation recording or copying a bare-name cross-instance edge needs all-match enumeration, rejection of intra-root duplicates, and round-trip validation from every context that will interpret the stored name.
tags: [relations, lineage, ambiguity, kernel, contract]
timestamp: 2026-07-25
---

# Lesson

Any OAS operation that records a bare instance name in cross-instance lineage
metadata has to treat the name as ambiguous until proven otherwise. Attached
ownership, the retire splice, and ordinary relation anchors share the same
posture: enumerate all candidates across the local root and team scope instead
of accepting the first local-first hit.

Enumeration has to include every match inside each agents root, not just one
candidate per root. Generated instance names can collide within the same root
(for example, a purpose-derived name and an agent slug can converge). Because a
root qualifier cannot distinguish two same-named homes under one root,
ambiguity-sensitive callers need an all-matches lookup and must reject
intra-root duplicates with guidance to retire or rename one of them.

When multiple candidates match, fail with `E_RELATIVE_AMBIGUOUS` and list the
candidate homes unless the caller supplies an explicit qualifier. The CLI
qualifier is `--relative-root <agents-root>`; the kernel option is
`o.relativeRoot`. The qualifier selects among real candidates only. Persisted
lineage fields remain bare names, so the selected name still has to resolve back
to the chosen home from the root that will consume the edge. A qualifier naming a
shadowed foreign anchor is rejected because consumers could not resolve the
stored edge to that home.

# Inherited edges

Sibling and parent relations can copy existing bare lineage names from the
anchor's metadata onto the new instance. Validating only `relativeTo` is not
enough because the copied name was interpreted from the anchor's agents root but
will be consumed from the new instance's root. Each final inherited edge must
resolve from both roots to the same canonical home before being stored. If the
name is dangling from both roots, copying it does not make the graph worse; if it
resolves differently, reject before scaffolding.

General rule: whenever lineage metadata is copied between contexts that
interpret bare names differently, re-validate each copied name in the destination
context as well as the source context.

# Reverse edges

Check reverse edges with the same ambiguity posture. `relation=parent` writes an
edge on the anchor (`anchor.parentInstance = <new instance bare name>`), so the
new instance's name must round-trip from the anchor's root. Because the new
instance does not exist at that check point, any existing hit for that name from
the anchor's root is a shadow. Reject before scaffolding so the anchor remains
untouched.

# Contract boundary

The disambiguator is an operation-time qualifier; it is not persisted into
lineage metadata. Keeping persisted fields as bare names avoided a lineage
migration and desktop schema change for the anchor ambiguity fix, leaving only a
new optional flag and error code in the shared contract. That shared contract
change was proposed to the coordinator before implementation.

# Related

This extends the broader [names are not identity](/lessons/names-are-not-identity.md)
rule and the [path-first resolution](/lessons/path-first-resolution-round-trip.md)
round-trip check to ordinary relation anchors and reverse edges. The sparse
lineage fields are summarized in
[spawn relations](/architecture/spawn-relations-lineage-fields.md).
