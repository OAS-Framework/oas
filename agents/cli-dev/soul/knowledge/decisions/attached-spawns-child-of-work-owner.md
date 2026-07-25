---
type: Decision
title: Attached spawns are children of the work-tree owner
description: Attached agents always inherit the shared work-tree owner as parent; contradictory relation flags are rejected, with only a redundant child-of-owner request accepted.
tags: [spawn, attached, lineage, relations, kernel, cli]
timestamp: 2026-07-25
---

# Decision

Attached work mode binds lineage: an attached spawn shares another instance's
work tree, so its `parentInstance` is the work-tree owner. This is not an
optional fallback callers may negate.

The owner must be canonical, not guessed from a `<name>/work` path shape. A
candidate instance name must resolve to a known instance and
`realpath(instanceHome/work)` must equal the attached `workDir`; legitimate
non-instance integration work trees need an explicit `--parent`/parent option.

Because soul defaults and capability hooks can request attached work without a
CLI `--work attached` flag, enforce this in both surfaces: contradictory
relation options on an attached spawn fail before scaffolding (`E_BAD_ARGS` at
the CLI, kernel throw for programmatic callers). The only permitted relation
option is an explicit redundant child-of-owner request, because capability hooks
may already pass that parent explicitly.

This supersedes the interim behavior where `--relation unrelated` suppressed
attached auto-parenting. Attached agents are children by construction; relation
knobs describe non-attached spawn topology.

# Lifecycle consequence

Ephemeral attached service agents, including post-commit reviewers, are children
of the instance whose tree they share. That keeps retirement lifecycle
responsibility local to the work owner. Non-attached overseers such as PR
maintainers still express their topology with `--relation parent`.

# Related

Details of sparse relation fields and retirement splice repair are in
[spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md).
