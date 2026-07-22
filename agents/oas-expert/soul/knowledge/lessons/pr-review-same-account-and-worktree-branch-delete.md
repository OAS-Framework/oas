---
type: Lesson
title: PR merge friction — same-account approval and worktree-held branch deletion
description: In single-account deployments, maintainer approval may need to be recorded as a PR comment, and branch deletion after merge may require deleting only the remote when another instance's worktree holds the local branch.
tags: [pr-review, github, worktree]
timestamp: 2026-07-22
---

This affects the maintainer PR gate described in [OAS development team — PR-only flow, review capability, capability-defined agents, model preference lists](/decisions/dev-team-and-review-flow.md).

# Same-account approval block

When the maintainer's `gh` authentication uses the same GitHub account that authored the PR, `gh pr review --approve` returns "Can not approve your own pull request". This is common in single-account OAS deployments where all agents push as one identity. Record the approval verdict as a PR comment instead; merging still works. Observed on PRs #8, #10, #12, and #13.

# Branch delete blocked by another instance's worktree

`gh pr merge --delete-branch` tries to delete the local branch as well as the remote. If a developer instance's worktree still has that branch checked out, the merge succeeds but local deletion fails with a "cannot delete branch ... used by worktree" error. Recover by deleting the remote branch with `git push origin --delete <branch>` and notifying the worktree owner to clean up their local branch.
