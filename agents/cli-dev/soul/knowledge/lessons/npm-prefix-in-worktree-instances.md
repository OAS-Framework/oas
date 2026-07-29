---
type: Lesson
title: Run npm with --prefix from a worktree instance — npm walks up into the main checkout
description: A stray cd to instance home makes npm find the main checkout's package.json, so the quality gate silently validates the wrong tree.
tags: [oas, worktree, tooling, quality-gate]
timestamp: 2026-07-29
---

# What happened

A worktree instance lives at `<instance-home>/work`, and `<instance-home>` sits
*inside* the main checkout's directory tree
(`<repo>/agents/<soul>/instances/<name>/`). The Bash working directory persists
between tool calls, so one command that `cd`s to instance home — e.g.

```bash
cd <instance-home> && aw mail inbox
```

leaves every later command there. `npm run check` then finds **no**
`package.json` in instance home, walks up, and lands on the **main checkout's**
`package.json`. It prints the right package name and version and passes happily,
having tested a tree that does not contain any of the branch's changes.

`git diff --check` has the same failure mode, and it is worse: it reports clean
because the main checkout *is* clean.

# The rule

Never rely on the persisted cwd for a gate. Address the worktree explicitly:

```bash
W=<instance-home>/work
npm --prefix "$W" run check
npm --prefix "$W" test
git -C "$W" diff --check
git -C "$W" rev-parse --abbrev-ref HEAD   # cheap proof you are on your branch
```

Print the branch name alongside the gate output — that one line is what makes a
wrong-tree run visible in the transcript instead of two hours later.

This is the mechanical counterpart to the CLAUDE.md rule "never run git from the
repo's main checkout": the danger is not only running git *in* the main
checkout, it is running any repo-scoped tool from a directory that *resolves* to
it.

See also [instance homes follow cwd into linked worktrees](/lessons/instance-homes-follow-cwd-into-linked-worktrees.md).
