---
name: review-handoffs
description: >-
  How to coordinate review handoffs without losing the reviewer to a stale
  commit. Use when sending a branch for review, reporting fixes to a reviewer,
  or deciding whether to run memory harvest while review is open. Covers branch
  tip SHA handoffs, copy-paste verification commands, stale-SHA triage, and
  deferring `oas okf harvest` until review closes.
---

# Review handoffs

Reviewers need a stable target. A bare commit SHA is only a snapshot. If the
branch moves while review is open, stale findings can look like unfixed bugs.

## Handoff format

When requesting or resuming review, lead with the branch name and current tip
SHA:

```text
Please verify branch <branch> (tip <sha>).
```

Then include a copy-paste check that resolves the branch name, not an old SHA:

```bash
git grep -nE '<pattern>' <branch> -- <paths>
```

## Reporting fixes

When you say a problem is fixed:

- Name the commit that applied the fix.
- Show the zero-hit `git grep` output or exit code at `HEAD`.
- Tell the reviewer to verify against the branch tip, not the earlier SHA.

## If a reviewer reports stale lines

Check the target before changing code:

1. Run `git rev-parse <branch>`.
2. Compare it with the SHA the reviewer checked.
3. If they differ, resend the branch name, current tip, and verification command.

## Harvest timing

Do not run `oas okf harvest` while review is open. Harvest can spawn a harvester
that commits to your work branch. That advances the tip under the reviewer.

Write notes as you work. Wait until the reviewer confirms the review is closed.
Then harvest once.

## Source lesson

See [Lead every review handoff with the branch tip, and defer harvest during review](../../knowledge/lessons/review-handoffs-branch-tip-defer-harvest.md).
