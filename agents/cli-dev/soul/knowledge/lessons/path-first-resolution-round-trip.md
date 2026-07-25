---
type: Lesson
title: Resolve path identity before recording names
description: When a path identifies an instance but metadata records a name, search candidate homes by path first and accept the name only if it resolves back to the same home from the consumer's context.
tags: [attached, ownership, identity, symlinks, kernel, relations]
timestamp: 2026-07-25
---

# Lesson

When a path identifies an instance but the metadata to persist is a name, do
not derive a name from the path shape and then look that name up. A same-named
local instance can shadow the true owner of a foreign work tree, so name-first
lookup can attach an instance to one tree while recording another instance as
its parent.

Use the path as the identity proof first:

1. Enumerate the candidate instance homes across the local root and team scope,
   then compare the work path against those candidates.
2. For symlinked checkout-mode `work` directories, `realpath(work)` collapses to
   the shared repository and is identical for every checkout instance of that
   repo. Match those only by the lexical parent relation
   (`realpath(home) + "/work" === canonicalized workDir`). Match real work
   directories by realpath equality.
3. After a candidate home matches, accept the name that will be recorded only if
   resolving that name from the consumer's context, with the same local-first
   then team-scope precedence other lineage edges use, lands back on the same
   home. If a same-named local instance breaks that round trip, reject the owner
   as ambiguous instead of recording either interpretation.
4. An explicit-parent fallback for a non-instance work tree is valid only when
   the path matches no known instance work directory. It must not bypass a
   failed path-first or round-trip verification.

# Related

This tightens attached-owner inference in
[attached spawns](/decisions/attached-spawns-child-of-work-owner.md), the
attached-mode source in
[spawn lineage](/decisions/spawn-lineage-explicit-only.md), and the broader
[names are not identity](/lessons/names-are-not-identity.md) rule.
