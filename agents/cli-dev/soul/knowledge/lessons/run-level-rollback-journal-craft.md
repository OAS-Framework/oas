---
type: Lesson
title: A run-level rollback journal must restore absence, keep its backup on failure, and be mutation-tested
description: Non-obvious constraints found building the CLI-private outer rollback journal — where the backup may live, why an incomplete rollback must not clean up, how anchor pruning falls out of ancestor bookkeeping, and why a restore test needs a mutant to prove it measures anything.
tags: [cli, transactions, rollback, filesystem, testing, symlinks, containment]
timestamp: 2026-07-29
---

Built for multi-step init and config-template adoption, which touch artifacts no
single engine call spans: active config, lock, flat installed capability store,
capability `.gitignore`, and the adopted template base plus metadata. The engine
exposes no transaction handle by design, so the run-level guarantee belongs to
the CLI (see [the frozen seam answers](/references/frozen-revised-v2-engine-seam-answers.md),
answer 5).

# The backup cannot live inside the tree it protects

Restoring a directory means deleting the current one first. A backup staged
under the scope is deleted by the very restore it exists to enable. Stage it
outside and assert containment at construction — the assertion costs nothing and
the failure mode is total.

# An INCOMPLETE rollback must keep its backup

The instinct is to clean up in a `finally`. Wrong: after a partial failure the
backup is the only surviving copy of the pre-run bytes. Deleting it converts a
recoverable failure into permanent loss — the same shape as the soul's
[rollback-retain-retry-state lesson](/lessons/rollback-retain-retry-state.md),
where compensation destroyed the only credential able to retry. Clean up only on
a *complete* rollback, and make the partial case re-runnable so fixing the cause
and rolling back again finishes it.

# Restoring ABSENCE is a first-class case, not an edge case

Half the artifacts do not exist when the run starts. "Restore" for those means
*remove*, and getting it right is what makes engine-created state compensable:
the engine transactionally ensures `.agents/capabilities/.gitignore` during an
operation that succeeds before the run fails later, so the journal must record
its prior absence and undo it.

# Anchor pruning falls out of ancestor bookkeeping

Recording which ancestor directories already existed at snapshot time turns
"remove a run-created `.agents` anchor only when empty" from a special case into
a consequence: prune deepest-first, skip anything that pre-existed, skip
anything non-empty. An `owned/` capability under the anchor keeps it alive
automatically, which is exactly the required behaviour and needs no rule of its
own.

# Symlink policy differs by position

A symlink **at** a protected path is fine: capture the target, restore it
verbatim, never write through it (`rmSync` unlinks the link, not the target). A
symlink in an **intermediate** component is fatal at snapshot time — restoring
through it would delete or rewrite outer-scope state the run never owned. Same
containment instinct as the kernel's [hoisted-path guards](/lessons/hoisted-resource-fallbacks-anchor-at-declaring-dir.md),
applied to a CLI-owned tree.

# Measured cpSync flags (node 22)

`cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true,
preserveTimestamps: true })` preserves mode bits (0755 survives), copies
symlinks as symlinks including at the top level, and keeps relative link targets
verbatim. Verified before relying on it rather than assumed.

# A restore test proves nothing until a mutant kills it

"Rollback restored the tree" passes trivially if the fixture never really
changed the tree — and it *also* passes against a rollback that does nothing at
all. Two cheap guards:

1. Assert the scope fingerprint **differs** after the mutation and before the
   rollback, inside the test itself.
2. Run a mutant (`rollback` restores nothing) and confirm it kills the suite.
   Mine killed six of seven; the survivor was the containment/backup test, which
   legitimately never exercises restore.

The fingerprint has to be type-, mode- and symlink-aware, or it silently ignores
exactly the properties hardest to restore.
