---
type: Lesson
title: API seam swaps must preserve reviewer-proven fix mechanisms
description: When replacing an API that gained an option because a reviewer proved a correctness bug, the replacement must re-establish that mechanism or restructure the consumer before the original regression is considered fixed.
tags: [seam, teardown, regression, api-swap, packages, review]
timestamp: 2026-07-26
---

# Lesson

A gate-2 package-engine seam replacement resurrected the same rerun-per-scope
restore bug that had already been fixed once. The pre-engine fix added a
`{ levels }` exact-level option to the WS2 seam `restoreCapabilities` /
`restorePackages` path plus a processed-level set, because reconciliation was
calling a chain-walking restore per discovered scope and filtering rows after
the side effect. During teardown, the engine's `restorePackages` replaced the
WS2 seam but did not have the exact-level option; `packageLockReport(level)`
kept the shape `restorePackages(level).filter(r => r.level === level)`, so the
same per-descendant rerun class returned.

An API option that exists because a reviewer proved a correctness bug is part
of the fix, not a convenience. When swapping to a replacement API that lacks the
option, either upstream the option or restructure the consumer so it no longer
needs it. In this case the safe consumer shape is: call the chain restore once
at the boundary and partition the report by level, rather than invoking the
chain restore once per scope.

After the swap, rerun the original regression tests that motivated the option
against the replacement implementation. A shallow fixture can still pass while
missing reruns; side-effect-counting restore tests need enough descendant
structure to prove the old duplicate side effect fails on the engine path too.
See the broader reconciliation rule in
[reconciliation truthfulness](/lessons/reconciliation-truthfulness-fixes.md)
and the seam direction in the
[package-engine teardown decision](/decisions/package-engine-seam-teardown.md).

# Related validation pattern

The same review round exposed a parallel validation seam: dependency-supplied
capabilities validated only by id let a profile bind a capability to the wrong
exclusive layer and still snapshot. If a validation rule depends on provider
manifest content, accepting an identifier is not enough; fetch the provider's
manifest before applying the rule. This belongs with the profile validation
split in [package profile validation](/lessons/package-profile-validation-config-shape.md).
