---
type: Lesson
title: Placement guards must validate the resolved destination
description: Canonical-home and containment guards can be bypassed by symlinked agent directories or instances directories unless they resolve the nearest existing ancestor of the exact destination immediately before side effects.
tags: [kernel, spawn, security, symlinks, fail-closed]
timestamp: 2026-07-27
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
