---
type: Lesson
title: Canonical deployment root is Git main worktree identity plus realpath mapping
description: canonicalAgentsRoot redirects an agents root discovered inside a linked worktree onto the primary checkout using the first `git worktree list --porcelain` record, and every containment comparison must be realpath-based.
tags: [kernel, spawn, worktrees, instance-home, git]
timestamp: 2026-07-27
---

# Lesson

`findRoot()` walks up from the invocation directory, so the agents root can land
inside a linked worktree; see [instance homes follow CWD into linked worktrees](/lessons/instance-homes-follow-cwd-into-linked-worktrees.md).
`canonicalAgentsRoot(root)` (`lib/core.mjs`, after `findRoot`) redirects that
root onto the primary checkout, and `ensureRoot()` returns the canonicalized root.
This keeps **deployment root** separate from **invocation CWD**.

# Main worktree identity

The first record of `git worktree list --porcelain` is the main worktree. That is
the whole identification mechanism: no branch name is involved, so the redirect
still works when the primary checkout is on a non-`main` branch. The parent of
`--git-common-dir` is only a fallback because separate-gitdir and bare layouts can
break that inference.

Git probes for this path must be argv-based (`execFileSync`), never
shell-interpolated: worktree paths and branch names may contain valid but hostile
metacharacters.

# Realpath trap

Git reports canonical paths. On macOS a temp root reached through `/var/...` while
Git reports `/private/var/...` makes a lexical `relative(toplevel, root)` produce
a `..`-prefixed path, which reads as "root is outside the work tree". That silently
skips canonicalization and leaves the linked-worktree placement bug in place.

Every containment comparison and `relative()`/`join()` mapping in this path must
use realpaths. The agents directory may not exist yet for local-only scopes, so
resolve the nearest existing ancestor and re-append the remainder instead of
letting `realpathSync` throw.

This is the same family as [canonical worktree verification](/lessons/canonical-worktree-verification.md):
when Git hands back a path, compare realpaths, not lexical strings.

# Fail-closed boundary

Leave behavior unchanged for non-Git scopes, for the main worktree itself, and for
roots outside the work tree they were discovered from. When the scope is a linked
worktree but the primary checkout cannot be established — git failure, no main
record, missing directory, or containment escape — throw `E_NO_CANONICAL_ROOT`.
Guessing recreates the misplacement that `canonicalAgentsRoot` exists to prevent.

`spawnInstance` must re-check the raw caller shape before any side effect because
the desktop server, adapters, and tests can call it directly and bypass the CLI's
`ensureRoot`. This is the same posture as [kernel validation before side effects](/lessons/kernel-validation-before-side-effects.md).

# Verified

Full gate was green after the fix: 750 tests, check, check:pi, validate,
validate:okf, and pack:check. A real linked-worktree probe changed
`ensureRoot()` from returning `/private/tmp/oas-strict-curriculum-spike/agents` to
returning `/Users/pepe-reyero/oas/agents`; `oas status --json` from that worktree
changed from reporting the worktree root with no instances to reporting the
deployment root with its real instances.
