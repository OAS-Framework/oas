---
type: Lesson
title: Cross-instance mutations need late commits and compensation
description: Spawn-style operations must put cross-instance metadata writes after earlier fallible steps, and compensate any launched/scaffolded side effects if that final write fails, to avoid half-recorded lineage.
tags: [kernel, spawn, transactionality, lineage, ordering, compensation]
timestamp: 2026-07-25
---

# Lesson

Merged-state review #3 of spawn relations (fixed in 68bb1c5) found that the
parent-relation anchor rewrite ran before the tmux launch step. That launch can
still fail because tmux is missing, the window name collides, or `new-window`
errors. The failure path then made `spawnInstance` throw after scaffolding the
new home, while the live anchor instance already had `parentInstance` pointing at
that new zombie home.

Order side effects by who owns the mutated state:

- Writes to the operation's own artifacts, such as the new home or its
  `instance.json`, may happen early because a failed home is inert and can be
  cleaned or ignored.
- Writes to another instance's state, such as an anchor re-point, are commits on
  a live healthy instance. Perform them only after the last remaining fallible
  step succeeds.
- If a later fallible step must follow a cross-instance write, restore the other
  instance on failure; prefer reordering over compensation when possible.
- `--no-launch`-style short-circuit paths count as success for their own scope,
  so place the cross-instance commit where both launched and no-launch paths pass
  after their respective last fallible step.

The "last" cross-instance write is also fallible. When an irreversible-ish step
such as a tmux launch must precede the write, ordering alone is not enough: make
the write a compensated transaction. On metadata-write failure, kill the launched
window by exact-match tmux target, remove the worktree/branch and scaffolded
home, then rethrow with the rollback named. The invariant is all-or-nothing:
either the agent is live and lineage is recorded, or neither remains.

For multi-step operations with one cross-instance commit, use this sequence: own
scaffolding → fallible external steps such as launch → cross-instance commit
with compensation for everything before it.

For launch-failure coverage, use a PATH directory with the fake runtime shims and
a real `git` symlink, but no `tmux`. That forces `which("tmux")` to fail after
scaffolding has completed. Stripping PATH entirely breaks on `git` first and
exercises the wrong failure. For metadata-write failure coverage, chmod both the
anchor `instance.json` to `444` and its directory to `555`; file mode alone may
not block all write paths. Assert the throw plus full rollback (no scaffold home,
anchor unchanged), and restore modes in `finally` so cleanup can delete the temp
tree.

This extends the no-side-effects posture in
[kernel validation before side effects](/lessons/kernel-validation-before-side-effects.md)
and the parent-relation shape in
[spawn relations](/architecture/spawn-relations-lineage-fields.md).
