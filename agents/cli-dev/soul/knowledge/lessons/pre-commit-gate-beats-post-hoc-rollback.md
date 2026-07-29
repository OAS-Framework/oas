---
type: Lesson
title: A refusal that needs the old bytes must be a pre-commit gate, not a post-hoc rollback
description: Undoing a committed package update by re-acquiring the previous version silently fails when the source itself has moved on; the policy check belongs inside the staging transaction.
tags: [kernel, packages, transactions, update, rollback]
timestamp: 2026-07-29
---

# The bug

`updatePackage` refused an update that would drop a capability the config still
references — but it decided *after* `acquirePackage` had already committed:

```js
const r = acquirePackage(level, spec, { replace: true, expectPackage: packageId });
const removed = before.capabilities.filter((c) => !after.capabilities.includes(c));
if (removed.length && blockers.length) {
  // "put the previous version back"
  try { acquirePackage(level, previousSpec, { replace: true, expectPackage: packageId }); } catch {}
  throw oasError("remove-blocked", ...);
}
```

For a `path:` source — and for any git source whose selected root changed — that
recovery re-acquires **from the source that just dropped the export**. It cannot
put the old capability back. The observable result: `remove-blocked` was raised
correctly, but the lock had already lost the dropped capability's row while its
artifact directory was still on disk. The *next* `oas update` then saw
`before.capabilities` without it, computed `removedCapabilities: []`, and the
orphaned artifact was never retired.

The test that caught it looked like it passed for the right reason
(`existsSync(artifact(s, "x.going"))` was true) — the artifact was there, just
orphaned. Only asserting the **lock bytes** were unchanged exposed it.

# The fix

Give the transaction a caller-supplied pre-commit gate. `acquirePackage` now
takes `opts.assertCommittable(plan)` and calls it after the closure is projected
in staging but before the ignore/artifact/lock commit block:

```js
if (opts.assertCommittable) {
  opts.assertCommittable({
    packages: [...resolved.values()].map((r) => ({ package: r.package, capabilities: r.capabilities.map((c) => c.id) })),
    capabilities: projected.map((p) => ({ capability: p.capability, package: p.package })),
  });
}
```

`updatePackage` moves its config-reference check into that callback. A refusal
now costs nothing to undo because nothing durable was written, and the assertion
becomes the strong one: *lock bytes byte-identical, artifact integrity
unchanged*.

# The general rule

**Any policy decision that would need the pre-operation bytes to recover must be
evaluated while those bytes are still the live ones.** "Do it, then undo it" is
only safe when the undo is a pure inverse; re-deriving state from an external
source is not an inverse. See [final package lifecycle transaction invariants](/lessons/final-package-lifecycle-transaction-invariants.md).

The corollary for tests: for a refused transaction, assert the *bytes* (lock
content, artifact integrity), never just `existsSync`. Presence survives exactly
the corruption you are trying to catch.
