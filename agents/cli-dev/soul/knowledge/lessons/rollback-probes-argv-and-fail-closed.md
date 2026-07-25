---
type: Lesson
title: Rollback verification probes must be argv-based and fail closed
description: Public branch/ref values must never be interpolated into shell probes; cleanup verification needs three outcomes, and unverifiable checks belong in incomplete rollback diagnostics.
tags: [security, shell-injection, rollback, probes, git, tmux]
timestamp: 2026-07-25
---

# Lesson

reviewer-323d6f3 found a command-injection blocker and fail-open cleanup probes
(fixed in 00f769e): public refs used during rollback verification are still
public input, and a probe that cannot verify cleanup is not proof that cleanup
succeeded.

- Git accepts ref names containing shell command substitution syntax, for
  example `refs/heads/foo$(id)`. A public `--branch` value interpolated into
  shell command text such as `git ... refs/heads/${branch}` can execute during
  rollback. Path/ref validation is not shell safety: pass every public ref or
  branch as a distinct argv element to `execFileSync`, never interpolate it into
  command text.
- A cleanup probe has three states: confirmed absent, still present, and could
  not verify. Helpers that map probe errors to empty output turn the third state
  into the first, which makes rollback fail open. Rollback diagnostics must add
  both present and unverifiable outcomes to `incomplete`.
- For `git rev-parse --verify --quiet`, exit 0 means the ref is present; exit 1
  with empty stderr means confirmed absent; other failures mean unverifiable.
  For tmux and worktree lists, command failure is unverifiable, never an empty
  list.

This sharpens the rollback truthfulness rule in
[cross-instance writes](/lessons/cross-instance-writes-commit-last.md): cleanup
verification must be both shell-safe and fail-closed before reporting success.
