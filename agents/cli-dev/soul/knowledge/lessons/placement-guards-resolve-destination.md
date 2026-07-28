---
type: Lesson
title: Placement guards must validate the resolved destination
description: Placement and containment guards must positively verify resolved destinations and trusted bases immediately before side effects, not rely on redirect helpers or lexical paths.
tags: [kernel, spawn, security, symlinks, containment, fail-closed]
timestamp: 2026-07-28
---

# Lesson

A lexical path says nothing about where creation will land once a symlink appears
anywhere along it. A canonical-home guard that validates the agents root or agent
directory lexically can still create the instance in a linked worktree when:

```text
<primary>/agents/alias  ->  <linked-worktree>/agents/dev
```

If `canonicalDeploymentPath()` probes `dirname(abs)`, the agent directory
lexically sits in the primary checkout, is classified from the primary checkout,
and passes. `spawnInstance` can then create `agent._dir/instances/<name>`
through the symlink in the linked worktree — exactly the placement the guard
exists to prevent. A pre-existing `agent._dir/instances` symlink is the same bug
by another route.

# Rule

Any guard about **where** something lands must resolve the destination: compute
the realpath of the nearest existing ancestor and re-append the not-yet-created
segments. Validate that resolved destination immediately before the first side
effect.

Lexical checks may remain for diagnostics, but the guarantee must not rest on
them.

# Positive containment, not one known redirect

A containment rule must state where a path **may** go, not which known bad case it must avoid.
A guard built from `canonicalDeploymentPath(resolved)` only detected linked-worktree redirects;
for any path Git did not own, that helper returned the input unchanged, so a pre-existing
`instances/` symlink to an arbitrary directory passed. The reported home was inside the
deployment while the real files, including capability credentials, landed elsewhere.

The durable form is equality against the object OAS intended to create: the resolved home must
be `<resolved agent dir>/instances/<instance>`, and the resolved agent dir must lie inside one
of the deployment's allowed bases.

# The bases need containing too

A positive rule still fails if it trusts derived bases after resolving them. For example,
`<scope>/local-agents -> /foreign/repo` made `/foreign/repo` an allowed base unless the base
itself was checked against the scope. The agents root the operator supplies may legitimately
be a symlink; everything OAS derives from that anchor, such as sibling `local-agents` or nested
legacy dirs, has to remain under the anchor it claims to be under.

# Re-assert after creation

A path check expires the moment it returns. If composition or runtime preflight runs between
validation and `mkdirSync`, another writer can swap a parent directory for a link during the
window. Re-resolve the home immediately after creating it and before writing bytes or running
hooks; if it is not the intended destination, remove only the empty directory OAS just created
and abort. Do not recursively delete an unexpected resolved destination, because it is not
OAS-owned state.

This narrows the race; it does not eliminate it. Node lacks an `openat`/`O_NOFOLLOW`-relative
creation API, so hostile local filesystems still require OS-level protection on the deployment
directory. Say that where maintainers and operators will read it rather than implying a
pathname check is a complete security boundary.

# Not a symlink ban

A symlinked agents root that resolves back inside the primary checkout is
legitimate and must keep working; the deployment layout uses such links. The
check is about the resolved destination, not about symlinks being present.

# Related

This is the same family as [canonical agents root identity](/lessons/canonical-agents-root-git-identity.md),
which realpaths paths Git reports, and [instance names are not identity](/lessons/names-are-not-identity.md),
which resolves and compares canonical objects before acting. The general shape:
identity and location are properties of the resolved object, never of the string
that referred to it.
