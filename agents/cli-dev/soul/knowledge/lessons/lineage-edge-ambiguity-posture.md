---
type: Lesson
title: Lineage edges need ambiguity posture in both directions
description: Any operation recording a bare-name cross-instance edge needs enumeration of all candidates, an explicit disambiguator when multiple match, and round-trip verification from the edge's consumer root, including the reverse edge when the operation mutates another instance.
tags: [relations, lineage, ambiguity, kernel, contract]
timestamp: 2026-07-25
---

# Lesson

Any OAS operation that records a bare instance name in cross-instance lineage
metadata has to treat the name as ambiguous until proven otherwise. Attached
ownership, the retire splice, and ordinary relation anchors share the same
posture: enumerate all candidates across the local root and team scope instead
of accepting the first local-first hit.

When multiple candidates match, fail with `E_RELATIVE_AMBIGUOUS` and list the
candidate homes unless the caller supplies an explicit qualifier. The CLI
qualifier is `--relative-root <agents-root>`; the kernel option is
`o.relativeRoot`. The qualifier selects among real candidates only. Persisted
lineage fields remain bare names, so the selected name still has to resolve back
to the chosen home from the root that will consume the edge. A qualifier naming a
shadowed foreign anchor is rejected because consumers could not resolve the
stored edge to that home.

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
