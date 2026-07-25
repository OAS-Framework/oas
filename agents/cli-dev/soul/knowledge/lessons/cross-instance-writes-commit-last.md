---
type: Lesson
title: Cross-instance mutations must commit after the last fallible step
description: Cross-instance metadata writes in spawn-style multi-step operations must happen only after every remaining fallible step succeeds, or use compensation, so failures do not strand healthy instances pointing at zombies.
tags: [kernel, spawn, transactionality, lineage, ordering]
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

For launch-failure coverage, use a PATH directory with the fake runtime shims and
a real `git` symlink, but no `tmux`. That forces `which("tmux")` to fail after
scaffolding has completed. Stripping PATH entirely breaks on `git` first and
exercises the wrong failure.

This extends the no-side-effects posture in
[kernel validation before side effects](/lessons/kernel-validation-before-side-effects.md)
and the parent-relation shape in
[spawn relations](/architecture/spawn-relations-lineage-fields.md).
