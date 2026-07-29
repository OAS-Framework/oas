---
type: Lesson
title: Catalog-first classic init is networked, untrusted, and needs post-materialization layer checks
description: Routing official fundamental layers through the package catalog makes classic init clone the package, leave executable trust false until oas trust, and validate layer agreement against the materialized manifest inside the run transaction.
tags: [cli, init, packages, catalog, trust, capability-materialization]
timestamp: 2026-07-29
---

# The semantic change

When classic `oas init` routes an official fundamental layer through
`officialCapabilityPackage` plus `acquirePackage`, the operation is no longer the
legacy marketplace copy path. For example, `oas init --knowledge oas.okf` clones
from the catalog URL; in the materialization task this measured about 1.8s and
wrote a lock at the exact commit with `trusted: false`.

# Trust rule

Package acquisition does **not** imply executable trust. Tests or code that
assert `cap.trust.trusted` immediately after this classic-init path are asserting
retired marketplace semantics. The executable surface remains blocked until an
operator runs `oas trust`.

The older marketplace-copy route is different because it copies kernel-shipped
capabilities and records trust at acquisition; see
[marketplace trust and hoisted paths](/lessons/marketplace-trust-and-hoisted-paths.md).
Do not carry that trust assumption across to catalog package acquisition.

# Layer validation rule

The pre-mutation layer check can only examine a local marketplace copy or an
already-present artifact. For a catalog-only capability, the manifest that proves
which fundamental layer it supplies does not exist locally until after package
materialization.

Classic init therefore must re-check the layer claim against the
**materialized manifest** inside the run transaction. If the manifest disagrees
with the requested layer, roll back the whole init run rather than leaving a
partially materialized package/config pair.

# Fixture gotcha

When a test is meant to exercise the post-materialization layer check, use a
fixture-only capability id. If the id also exists in the kernel marketplace, the
pre-mutation check can silently validate against that marketplace copy instead
of reaching the catalog-only path under test.
