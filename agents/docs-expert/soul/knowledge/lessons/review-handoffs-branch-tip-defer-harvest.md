---
type: Lesson
title: Lead every review handoff with the branch tip, and defer harvest during review
description: Branch tips can advance across review rounds, so handoffs should name the branch plus current tip SHA and memory harvest should wait until review closes.
tags: [coordination, review, git, aweb, memory-harvest, docs]
timestamp: 2026-07-29
---

# Lead review handoffs with the branch tip; defer harvest during review

Two coordination failures cost several round-trips on the capability-materialization
docs review. Both are avoidable.

## A moving tip SHA makes reviewers verify the wrong commit

Across review rounds, the branch tip advanced from `41a37c2` to `4ff3a37` to
`11ee223` to `4287433`. The coordinator anchored review to an older SHA,
grepped `4ff3a37`, and re-reported stale lines that the next commit had already
fixed. The same return came back three times because of SHA drift, not because
the fix was missing.

Lead every handoff with the branch name and its current tip SHA. State it as
"verify against `<branch>` (tip `<sha>`)" instead of giving only a bare SHA that
can go stale.

Give the reviewer a copy-paste verification command that uses the branch name,
so their ref resolves to the tip:

```bash
git grep -nE '<pattern>' <branch> -- <paths>
```

When reporting a fix, show the grep exit code or zero-hit output at `HEAD` as
proof in the same message. Name the commit that applied the fix. If a reviewer
reports stale lines, first run `git rev-parse <branch>` and compare the result
to the SHA they checked. A SHA mismatch is the likely cause before assuming the
fix is missing.

## Do not harvest notes during an open review

`oas okf harvest` can spawn an agent that commits the promoted lesson to your
work branch. That advances the tip under the reviewer and feeds the SHA-drift
problem above. Two harvest commits, `4b9d3c7` and `4287433`, sat between the
docs commits and became noise in the integration commit map.

During an open review, write `notes/` as you go. They live in the instance home,
not the work tree, so they do not change the branch tip. Defer `oas okf harvest`
until the reviewer confirms closure. Then harvest once, so the final tip is
stable and the integration map is just the docs commits.
