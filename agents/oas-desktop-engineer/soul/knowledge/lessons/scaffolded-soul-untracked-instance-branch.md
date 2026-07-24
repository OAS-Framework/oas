---
type: Lesson
title: A freshly scaffolded soul is untracked on main — commit it through the instance branch
description: When a new soul is scaffolded directly at the repo root it is untracked by git, so the first instance must copy it into its worktree, commit it on its branch, and rsync knowledge back so the live soul dir stays usable by running sessions.
tags: [oas, soul, git, worktree, migration]
timestamp: 2026-07-24
---

The oas-desktop-engineer soul was scaffolded at
`/Users/pepe-reyero/oas/agents/oas-desktop-engineer/soul` on the main checkout,
where it showed as `?? agents/oas-desktop-engineer/` and was invisible to the
instance worktree branch.

The fix was to copy the scaffold into
`work/agents/oas-desktop-engineer/soul`, do all knowledge migration there so it
is reviewed and merged like code, and rsync the resulting `knowledge/` back to
the physical soul dir so live instance sessions whose `./soul` symlink points at
the physical dir see the migrated bundle immediately, before the PR merges.
