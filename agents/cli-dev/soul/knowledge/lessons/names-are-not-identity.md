---
type: Lesson
title: Instance names are not identity
description: Cross-instance references by bare name must be resolved from the referrer's context and realpath-compared before acting; path-identified owners need path-first matching and name round-trip verification before recording.
tags: [lineage, identity, retire, attached, kernel, relations]
timestamp: 2026-07-25
---

# Lesson

A bare instance name is not an identity. Names are only unique within an agent's
instance directory, so `dev-1` or purpose-based names can exist in several
member repositories of a team.

Operations that act on "instances that reference NAME" must prove each edge
resolves to the exact subject. For retirement splice repair, resolve the
referenced name from the referrer's agents root using the same precedence spawn
used to create the edge: local-first `findInstanceHome`, then team-scope
`findTeamInstance`. Only relink when the resolved home realpath equals the
retiree's home realpath. Run this splice before deleting the retiree's home, or
resolution can no longer land on it.

Inferred attached ownership must be path-first and round-trip checked. Do not
treat any path shaped like `<owner>/work` as an owner, and do not guess a name
from the path before searching for the matching instance home. Enumerate known
candidate homes across local and team scope, match symlinked checkout `work`
paths by lexical parent relation and real work directories by realpath equality,
then accept the recordable owner name only if resolving that name from the
consumer's context lands back on the same home. If the name is shadowed or the
round trip fails, reject the owner as ambiguous. For legitimate attached work
trees that match no known instance work directory, require explicit ownership
(`--parent`) instead of inferring from path shape.

# Test fixture gotcha

When asserting that an instance was not relinked by name across repos, use
distinct instance names on the two sides; otherwise the assertion can collide
with a legitimately relinked same-named instance.

# Related

This specializes the retirement splice scope in
[spawn relations](/architecture/spawn-relations-lineage-fields.md), the
explicit-lineage rule in [spawn lineage](/decisions/spawn-lineage-explicit-only.md),
the [path-first round-trip lesson](/lessons/path-first-resolution-round-trip.md),
and the attached-owner binding in
[attached spawns](/decisions/attached-spawns-child-of-work-owner.md).
