---
type: Lesson
title: Resolving a scope without a soul hides every type- and soul-targeted capability
description: aggregateMissingRequirements called resolveOasConfig(scope) with no soul name, so capabilities bound by agent-types or souls contributed no requirements at all — a fail-open that global-targeted tests could never catch.
tags: [capabilities, requirements, config-cascade, fail-open, testing]
timestamp: 2026-07-27
---

# Lesson

`resolveOasConfig(scope)` and `resolveOasConfig(scope, soulName)` answer **different
questions**. Without a soul name, capabilities bound by `agent-types:` or `souls:` are not
active, because there is no soul to match. `aggregateMissingRequirements` used the
soul-less form, so every requirement of a targeted capability — host commands as much as
runtime packages — was silently never raised.

The fix is to union the scope-level set with each known soul's set, keyed by capability id.

# Why it survived a full suite

Every existing test bound its fixture capability with `global: true`, which IS visible to a
soul-less resolution. The gap was invisible to the tests **and** to the feature I was
adding on top of it. I only found it because a runtime-scoping test used type targeting and
failed for what looked like the wrong reason.

Generalisation worth keeping: when a resolver takes an optional discriminator (a soul, a
type, a scope), a test suite that always passes the *same* value proves far less than it
appears to. Vary the discriminator, or the untested branch quietly rots.

# Related trap in the same change

The literal NUL byte in `lib/packages.mjs` was written off as a nit. It is not: `grep` and
`rg` classify a file containing one as **binary and suppress matches silently**. During
this work it made me believe committed code was absent — I ran `grep -c` on a symbol that
was demonstrably in the file and got nothing, then started "restoring" work that had never
been lost. Any control character in source can invalidate every search you do afterwards.

See also [runtime-package requirements](/lessons/runtime-package-requirements.md).
