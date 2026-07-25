---
type: Lesson
title: Cross-instance mutations need late atomic commits and compensation
description: Spawn-style operations need late atomic cross-instance metadata writes, rollback that compensates launched/scaffolded side effects, and truthful diagnostics for incomplete cleanup.
tags: [kernel, spawn, transactionality, lineage, ordering, compensation, diagnostics]
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
the write a compensated transaction. A rollback-completeness review (fixed in
4b74c68) added three checklist items for that transaction:

- The guarded metadata write must be atomic. Do not use `writeFileSync` on the
  target, because a mid-write ENOSPC/IO failure can truncate the other
  instance's `instance.json` before rollback can help. Write a same-directory
  `<target>.tmp-<uniq>` file, `renameSync` it over the target, and remove the
  temp file in catch paths.
- Rollback must compensate external capability state while the scaffolded home
  still exists. Spawn hooks may have provisioned state keyed to files inside the
  home, such as an aweb identity and roster record; run matching retire hooks
  best-effort with the spawn hook metadata before deleting the worktree/home.
- Every rollback step must be independently guarded. A failed cleanup action is
  part of best-effort compensation, not a reason to skip later cleanup or mask
  the original failure; keep rethrowing the original error after the rollback
  chain finishes.
- Rollback diagnostics are an operator contract. Collect each cleanup failure
  with the affected path and reason; use full-success wording only when every
  step actually succeeded. If any cleanup or verification failed, keep the
  original error primary but report a `rollback INCOMPLETE — clean up manually:`
  message that names the remaining items instead of a fixed success string.
- Compensation cannot infer swallowed hook failures from try/catch. Helpers that
  keep going on error, such as `runLifecycleHooks`, must return structured
  failure records alongside warnings (for example
  `results.failures: [{ capability, event, message }]`) so rollback logic can
  detect and report them; warning prose alone is advisory.
- Verify cleanup effects when the step API can hide failure. `shTry` returns
  trimmed stdout, so `""` is the normal success value for silent commands and
  `undefined` only means the shell command threw; do the effect check
  unconditionally after the attempted cleanup. After best-effort tmux kill,
  check `tmuxWindows(session)` no longer contains the launched window; after
  `rmSync(home, { recursive: true, force: true })`, check `existsSync(home)`
  before telling an operator the scaffold was removed.
- Git cleanup needs effect verification too: after best-effort worktree remove,
  prune, and branch delete, assert `git worktree list --porcelain` no longer
  contains the tree and `git rev-parse --verify --quiet refs/heads/<branch>`
  fails. The exit codes are discarded by `shTry`, and partial failure can strand
  git metadata.
- Rollback must remove launched/scaffolded side effects: kill the launched
  window by exact-match tmux target, remove the worktree/branch and scaffolded
  home, then rethrow with the rollback named. The invariant is all-or-nothing:
  either the agent is live and lineage is recorded, or neither remains.

For multi-step operations with one cross-instance commit, use this sequence: own
scaffolding → fallible external steps such as launch/hooks → atomic
cross-instance commit with compensation for everything before it. Do not treat
`rmSync(..., { force: true })` as unthrowable cleanup: `force` suppresses
missing paths, but `EPERM`, `EISDIR`, and I/O errors still propagate unless that
specific step catches them.

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
