---
type: Decision
title: Dropped exports retire inside the acquire commit, and rollback state is registered before the first rename
description: updatePackage deleted dropped-export artifacts after the lock commit, leaving a lock/store disagreement window and rollback with no route back.
tags: [oas-kernel, transactions, capability-materialization, rollback]
timestamp: 2026-07-29
---

# Two problems, one transaction boundary

## Post-commit retirement

`updatePackage` let `acquirePackage` commit the lock and then ran
`rmSync(installedCapabilityDir(level, cid))` for dropped exports. Between those
steps, the lock says the capability is gone while the artifact is still there.
If the removal failed, `updatePackage` threw after the lock was committed, with
no route back.

Retirement now happens inside the acquire transaction: artifacts for capability
rows that `replacePackages` is about to drop move into staging before the lock
write. Success lets staging cleanup delete them; failure restores them with the
rest of the transaction. `acquirePackage` reports what it retired.

## Rollback state before destructive moves

The swap loop used to push its `{ dest, backup }` rollback record only after both
renames succeeded. If the second rename failed, the pre-existing artifact was
already in staging with no rollback record; rollback restored nothing and staging
cleanup then deleted it.

The record now joins the rollback list before the first destructive rename. That
ordering is correct by construction: register the undo before doing the thing.

# Coverage honesty

The retirement fix is pinned by an injected failure and its mutant dies.

The rollback-ordering fix is not reachable from the public API in-process. Every
exception the API can raise lands either before an iteration starts or after it
completes, where the old ordering was already correct. The closed window is
process death, SIGKILL, or ENOSPC between the two renames — real, but not
something an in-process injection can produce. Keep the ordering because it costs
nothing and is the only construction that does not rely on case analysis, but do
not claim test coverage for it.

This has the same testing-honesty shape as [the capability-id containment proof](/decisions/capability-id-grammar-and-containment-proof.md) and [the unreachable-guards lesson](/lessons/unreachable-guards-cannot-be-mutation-verified.md).

# Test-construction note

`assert.throws(fn)` returns `undefined` when it passes; it does not hand back the
error. Use try/catch when a test needs to inspect an injected failure.

See also [provider rows resolve at their own lock level](/decisions/provider-rows-resolve-at-their-own-lock-level.md) and [the pre-commit gate lesson](/lessons/pre-commit-gate-beats-post-hoc-rollback.md).
