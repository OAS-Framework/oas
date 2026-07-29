---
type: Decision
title: A materialized capability id is a directory name, enforced by grammar at two chokepoints
description: Revised-v2 capability ids get one strict directory-name grammar in the lock reader and package-manifest validation, with installedCapabilityDir retaining a redundant containment proof as defense in depth.
tags: [security, capability-materialization, oas-kernel, path-containment]
timestamp: 2026-07-29
---

# The hole

A revised-v2 capability id becomes a directory name under
`.agents/capabilities/installed/`. The strict lock parser checked capability map
keys only for emptiness, and `installedCapabilityDir` was a bare `join()`, so a
hand-written lock with a key like `"../../evil"` could steer the filesystem
join out of the scope.

Package-exported ids had the same problem from the writer side:
`loadManifestAt` required only that an id be namespaced (`/[.@/]/`), and that
rule explicitly allowed `/` and `@`, so `../evil` satisfied it.

# The grammar

Materialized capabilities use the same directory-name grammar as package ids:

```text
^[a-z0-9][a-z0-9._-]*$
```

Namespaced dots are legal. Separators, `..`, absolute forms, `@`, and encoded
spellings are not.

The legacy v1 / owned / `from: path:` grammar remains loose on purpose: those
artifacts are named by `basename()` of their source, not by the declared id, so
the id never reaches a path there. Tightening that grammar would strand
already-published standalone capabilities.

# Two chokepoints, not N call sites

- The strict lock reader validates every revised-v2 capability map key before
  any consumer can join it, raising the existing `invalid-lock` code.
- Package manifest validation validates every exported id before a hostile id
  can be written, raising the existing `invalid-package-manifest` code.

# The containment proof is deliberately redundant

`installedCapabilityDir` also proves the resolved destination is an immediate
child of `installed/`. With the grammar above, mutation testing says that guard
is equivalent by construction: removing it while keeping the grammar changes no
observable behavior, because the grammar already excludes every character that
could escape.

Keep the proof as defense in depth against future grammar loosening, but do not
claim current behavioral coverage for it. What is pinned at the kernel API is
that a bare `join()` is not acceptable; that mutant dies. This has the same
testing-honesty shape as [the unreachable-guards lesson](/lessons/unreachable-guards-cannot-be-mutation-verified.md).

# Prototype-looking ids stay legal

`x.constructor`, `x.prototype`, and `x.__proto__` all satisfy the grammar and
must keep working. They are safe because the reader returns null-prototype maps,
so those spellings are keys rather than inherited properties. Bare `__proto__`
is refused only because the first character class excludes `_`. See also
[prototype-safe policy map lookups](/lessons/prototype-safe-policy-map-lookups.md).
