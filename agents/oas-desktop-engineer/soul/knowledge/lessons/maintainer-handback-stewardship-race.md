---
type: Lesson
title: Maintainer handback loops race the maintainer's own stewardship commits
description: When maintainer RETURN rounds add stewardship commits to main, treat named base SHAs as minimums: merge current origin/main, prove the named base is an ancestor, report the deviation, and answer duplicate stale crossed verdicts only once with git evidence.
tags: [delivery, pr-review, crossed-mail, mergeability, stewardship]
timestamp: 2026-07-26
---

# Lesson

Maintainer handback loops can become mergeability-only races when the
maintainer records each RETURN round as a stewardship commit on main. By the
time a handback lands, `origin/main` may already have advanced again, so a
GitHub comparison can report the branch as "behind by 1" even after the worker
merged the maintainer's previously named base.

This is a narrower delivery case of [crossed mail coordination](/lessons/crossed-mail-coordination.md): treat mail and named heads as evidence to verify against remote refs, not as a fresher source of truth than the repository.

# Pattern

- **Treat named base SHAs as minimums, not exact targets.** If the maintainer
  names a base and `origin/main` has already advanced past it, merge current
  `origin/main`, prove the named SHA with `git merge-base --is-ancestor
  <named> HEAD`, and report the deviation explicitly in the handback. Merging
  only the stale named SHA guarantees another round.
- **Make each handback self-contained.** Include the new head SHA, merge-base
  with `origin/main`, merge-delta summary, gate result, and any requested
  exact-head CI status in one message.
- **Answer stale crossed verdicts once.** Check claims with `git fetch`,
  `rev-parse`, and `merge-base` on remote refs, reply once with the evidence,
  and do not re-reply to duplicate verdicts about the same stale state.
- **Honor explicit STOP or hold instructions.** Acknowledge the hold even when
  local repository evidence says the branch is current.
- **Gate stewardship-only merges before pushing.** They are mechanical commits
  that do not need a post-commit reviewer, but still require the full root gate
  on the committed tree.
