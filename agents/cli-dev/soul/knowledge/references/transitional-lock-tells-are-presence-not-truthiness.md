---
type: Reference
title: Transitional lock row tells are own-property presence, and lock maps need null-prototype access
description: Why the revised-v2 discriminator must use Object.hasOwn rather than truthiness, and the measured prototype behaviour of JSON.parse that makes package-id lookups the real bypass vector.
tags: [lock, revised-v2, discriminator, prototype-safety, security, cli]
timestamp: 2026-07-29
---

Binding pin from `dev-coordinator-capability-materialization` (aweb mail
`42db67f7`, 2026-07-29), extending
[the discriminator coverage](/references/revised-v2-lock-discriminator-cli-coverage.md).
Post-GO scope.

# The predicate

```js
Object.hasOwn(row, "capabilities")
  || Object.hasOwn(row, "trustedCapabilities")
  || Object.hasOwn(row, "depsIntegrity")
```

Own-property **presence**, never truthiness and never array length. An empty
array or an empty string is still forbidden transitional evidence.

# Measured, not assumed (node 22)

```text
row = JSON.parse('{"capabilities":[],"trustedCapabilities":[],"depsIntegrity":""}')
  hasOwn-based predicate      → true    (correct: transitional)
  truthiness-based predicate  → false   (WRONG: reads as revised v2)
```

A truthiness test does not merely mis-sort an edge case — it accepts a
transitional lock as final revised v2, which is the exact outcome the central
`invalid-lock` exists to prevent.

# Where the prototype vector actually is

Also measured rather than assumed:

* `JSON.parse` on `{"__proto__": …}` creates an **own** `__proto__` property and
  does **not** pollute `Object.prototype`. So parsing a hostile lock is not
  itself a pollution vector, and `{ ...row }` preserves that own property
  harmlessly.
* The real vector is **lookup by package/capability id**. On a parsed object,
  `row["toString"]` returns an inherited function while
  `Object.hasOwn(row, "toString")` is false. A lock whose package id is
  `constructor`, `toString`, or `valueOf` therefore resolves to an inherited
  value under plain `map[id]` access — impersonating a configured entry, or
  bypassing a membership check that the id was never really in.
* `Object.assign(Object.create(null), row)` makes those lookups `undefined`
  again, which is the fix.

This is the same failure shape already recorded for
[policy registries](/lessons/prototype-safe-policy-map-lookups.md) — the lock
reader is another plain-object registry keyed by attacker-influenced names.

# Coverage owed

Central-reader fixtures for each empty-array/falsey tell and for hostile
prototype-named raw JSON, with **no mutation before the typed `invalid-lock`** —
classification must fail closed before any write, so a hostile lock cannot cause
a side effect on the way to being rejected.

**Ownership boundary:** the central reader lives in the engine
(`lib/core.mjs`) and its fixtures belong to `test/package-engine.test.mjs`,
which the CLI lane must not edit. The CLI lane owns the *CLI-visible* half:
doctor/install/migrate preserving the code and message verbatim with no side
effects. Both halves must be assigned explicitly or this coverage falls between
the lanes.
