---
type: Lesson
title: Init-time lock visibility applies to package locks too — read the target scope's own lock directly
description: During oas init --package, no oas-config.yaml exists at the target scope yet, so config-chain package lock reads miss that scope's oas-lock.json; init-adjacent resolution must merge readPackageLocksAt(dir) directly.
tags: [packages, init, locks, config-chain]
timestamp: 2026-07-26
---

# Failure mode

Implementing `oas init --package <locked-id> --json` exposed that resolution by
locked package id could fail with "not a locked package id" even though the
target scope's `oas-lock.json` contained that id.

The cause is the same init-time visibility trap as
[init acquires before config exists](/lessons/init-acquires-before-config-exists.md):
`readPackageLocks(startDir)` walks `configChain(startDir)`, and during init the
target scope has no `oas-config.yaml` yet. The chain skips that level entirely,
so that scope's lock is invisible.

# Rule

At init-adjacent call sites, merge the target scope's own lock directly into the
chain-derived package locks:

```js
{ ...readPackageLocks(dir).packages, ...readPackageLocksAt(dir) }
```

Any future code that resolves package lock state for a scope that may not yet
carry a config file needs the same direct read.
