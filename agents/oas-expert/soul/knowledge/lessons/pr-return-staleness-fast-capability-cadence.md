---
type: Lesson
title: Returned PRs can go stale under fast same-capability cadence
description: A PR returned only for merge conflicts can re-conflict before re-review when another PR on the same capability lands in between; handback should re-merge main and re-check mergeability.
tags: [pr-review, mergeability, process]
timestamp: 2026-07-22
---

PR #14's oas-web spawn-from-panel branch was returned for conflicts after PR
#13 landed. The author merged main as requested and re-requested review, but PR
#16, also in oas-web, merged before the round-2 review; the branch became
CONFLICTING again and the second review was another pure mergeability return.
See the [delivery log](/stewardship/delivery-log.md) entry for PR #14 round 2.

Mitigations for conflict-only returns:

- Authors should re-merge `origin/main` and check `gh pr view <n> --json mergeable`
  immediately before handback.
- Maintainers should consider sequencing or fast-tracking re-review when several
  PRs touch the same capability in one day.
- If same-account GitHub auth blocks `gh pr review --request-changes`, record
  the structured RETURN verdict as a PR comment, as with same-account approvals
  in [PR review friction — same-account review states and worktree-held branch deletion](/lessons/pr-review-same-account-and-worktree-branch-delete.md).
