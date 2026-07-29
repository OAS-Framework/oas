---
type: Decision
title: An unsupported transitional lock shape is detected by field PRESENCE, never truthiness
description: Rejecting the old package-root spelling of lockfileVersion 2 has to key on Object.hasOwn, because the giveaway fields are legitimately empty in exactly the locks a truthiness check would let through.
tags: [kernel, lock, migration, fail-closed]
timestamp: 2026-07-29
---

# Context

The founder ruling revised `lockfileVersion: 2` in place rather than minting a
v3. So two different documents both claim version 2: the current
capability-materialization shape, and the earlier transitional package-root
shape. The engine must reject the transitional one as `invalid-lock` — never
convert it, never partially interpret it.

# The detection predicate

Two independent arms, both required:

1. **No top-level capability map**, on a document that is not state-free.
2. **Any package row carrying a transitional field**:
   `capabilities`, `trustedCapabilities`, `depsIntegrity`.

```js
const TRANSITIONAL_ROW_FIELDS = ["capabilities", "trustedCapabilities", "depsIntegrity"];
const tells = TRANSITIONAL_ROW_FIELDS.filter((f) => Object.hasOwn(row, f));
```

# Why presence, not truthiness

`if (row.capabilities?.length)` — the obvious spelling — passes exactly the
documents that most need rejecting:

- a transitional package that exported nothing yet: `capabilities: []`
- a transitional package with no approvals: `trustedCapabilities: []`
- a **dependency-free** transitional row, which never had a `depsIntegrity` at
  all, so the one field a truthiness check would reliably catch is absent

Each of those would be read as a current-shape row with a stray key and then
silently normalized on the next write. `Object.hasOwn` is also what keeps a
prototype-named key from answering the question; see [policy maps require exact own-property membership](/lessons/prototype-safe-policy-map-lookups.md).

# The state-free exception

`{ lockfileVersion: 2, packages: {} }` carries no state to misinterpret, so
requiring a `capabilities` key there would break a scope that legitimately locks
nothing. The predicate is:

```js
const stateFree = !packageKeys.length && (!hasCapabilityMap || !Object.keys(parsed.capabilities).length);
```

Only a **non**-state-free document missing the capability map is transitional;
a state-free one normalizes to `{ lockfileVersion: 2, packages: {}, capabilities: {} }`.

# What is NOT a tell

`path` and `dependencies` are current-shape fields and appear in both spellings.
Using either as a discriminator rejects valid locks. Related:
[frozen interface first delivery](/lessons/frozen-interface-first-delivery.md).
