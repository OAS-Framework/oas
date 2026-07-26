---
type: Lesson
title: Policy maps require exact own-property membership
description: Plain-object policy registries must use Object.hasOwn-based membership helpers because inherited Object.prototype names can impersonate configured entries and bypass or corrupt validation.
tags: [security, javascript, validation, capabilities]
timestamp: 2026-07-26
---

# Exact membership for policy maps

A reviewer found that retirement-before-shape validation used
`RETIRED_CAPABILITIES[id]`. Since the registry is a plain object,
`constructor`, `toString`, and `__proto__` produced inherited truthy values and
were misclassified as retired. Migration accepted malformed entries and could
emit function source as bogus retirement guidance.

Policy, allow, deny, and retirement registries must use exact own-property
membership. Centralize the check in a helper such as
`retiredCapabilityReason(id)`, implement it with `Object.hasOwn`, and route
every runtime and CLI retirement check through the helper. `Object.keys` remains
safe for diagnostics; bracket lookup is not safe as a membership test.

Regression coverage should include malformed v1 entries named `constructor`,
`toString`, and `__proto__`. Both dry-run and apply paths must raise the typed
`invalid-lock` failure, and apply must preserve the existing lock bytes.

See also [package engine gotchas](/lessons/package-engine-implementation-gotchas.md)
and [test conventions](/playbooks/test-conventions.md).
