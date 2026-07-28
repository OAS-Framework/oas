---
type: Lesson
title: Replacing a porcelain git command with a plumbing one silently drops its conveniences
description: Checking out a resolved hash instead of the ref closed an option-injection hole but also removed checkout's remote-branch guessing, so every short non-default branch name stopped resolving.
tags: [git, packages, kernel, review, regression]
timestamp: 2026-07-28
---

Closing an option-injection fail-open meant replacing `git checkout <ref>` with
"resolve the ref to a SHA, then check out the SHA". Correct for safety, and it
quietly removed a feature nobody had written down.

`git checkout <name>` performs **DWIM guessing**: when `<name>` is not a local
branch but exactly one remote has `refs/remotes/<remote>/<name>`, it creates a
tracking branch and checks it out. `git rev-parse <name>^{commit}` does not —
its lookup order is `refs/`, `refs/tags/`, `refs/heads/`, `refs/remotes/`,
`refs/remotes/<name>/HEAD`, and **`refs/remotes/origin/<name>` is not in it**.

A plain clone materializes only the default branch locally, so every other
branch exists solely as a remote-tracking ref. Verified:

```text
local branches:  * master
rev-parse feature^{commit}:                       FAILS (exit 1)
rev-parse refs/remotes/origin/feature^{commit}:   9ac2c758…
```

Result: `<url>@feature` worked before the hardening and failed after it — at
all three call sites at once.

# The rule

When you swap a porcelain command for plumbing to make it safe, **enumerate
what the porcelain was doing for you** and re-implement the parts you still
want, explicitly. Safety is the reason to swap; feature parity is the work the
swap creates. Here the restoration is one extra resolution attempt
(`refs/remotes/origin/${ref}^{commit}`, still behind `--end-of-options`, and a
`refs/`-prefixed string cannot start with a dash), tried only after direct
resolution fails so git's own precedence for SHAs, tags and local branches is
untouched.

The fallback is a *resolution* path, not a relaxation: unknown refs and
option-like refs still fail closed, and the test asserts that explicitly.

# Ref shapes worth probing when you touch this

`^{commit}` does the right thing for the shapes that bite: an **annotated tag**
peels through the tag object to its commit, and a **blob or tree** fails
instead of resolving. Both confirmed by probe rather than assumed —
`atag^{commit}` matched `HEAD^{commit}`, and a blob SHA returned nothing.

See [public refs as option-injection vectors](/lessons/public-refs-are-option-injection-vectors.md)
for the hole this hardening closed.
