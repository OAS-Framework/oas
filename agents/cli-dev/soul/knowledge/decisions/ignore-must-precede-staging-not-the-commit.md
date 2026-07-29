---
type: Decision
title: The generated-artifact ignore is ensured before staging opens, not at commit
description: Staging lives under installed/, so fetched and materialized bytes must be ignored before the operation runs rather than only when the transaction commits.
tags: [oas-kernel, transactions, git, capability-materialization]
timestamp: 2026-07-29
---

# The window

`makeStaging` opens `.agents/capabilities/installed/.staging-XXXX`, and the whole
operation runs there: fetch, closure resolution, npm production install,
projection, integrity checks, and the caller's `assertCommittable` gate. All of
those bytes sit inside the work tree.

`ensureInstalledGitignorePreflight` used to run at commit time, after all of
that. For the entire operation, the staging tree was visible to `git status` and
committable by anything running meanwhile, including a pre-commit gate that
shells out to git.

`beginStaging(levelDir)` now ensures the ignore first and opens staging second,
returning the ignore handle so failure paths can undo it.

# Two gotchas

## Anchor accounting

Writing the ignore does `mkdirSync(.agents/capabilities, {recursive:true})`, so
it creates the same anchors `makeStaging` later inspects. If the operation
snapshots "which anchors are absent" after the preflight, directories it just
created look pre-existing, and a refused acquisition leaves `.agents/` and
`.agents/capabilities/` behind. Snapshot anchor absence before the ignore
preflight.

## Double rollback

The ignore is referenced by both the pre-staging path and the commit-time
failure path, so one failure can legitimately call `rollback()` twice. Rollback
must be one-shot; undoing twice can restore old bytes over a newer correct
state.

# Testing note

Plain `git status --porcelain` collapses an untracked directory to `.agents/`.
A test that asserts staging is invisible against plain porcelain passes whether
or not the ignore exists, because it never sees the staged paths. Use
`git status --porcelain -uall` for the assertion to mean anything.

Removing the outer ignore rollback breaks 20 engine cases, which measures how
much of the suite depends on a failed operation leaving the scope byte-identical.

See also [dropped-export artifact retirement](/decisions/artifact-retirement-belongs-inside-the-commit.md), [the run-level rollback journal lesson](/lessons/run-level-rollback-journal-craft.md), and [the frozen revised-v2 seam answers](/references/frozen-revised-v2-engine-seam-answers.md).
