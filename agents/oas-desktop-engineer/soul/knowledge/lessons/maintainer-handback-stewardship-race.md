---
type: Lesson
title: Maintainer mergeability loops need live-head verification and a hold discipline
description: In current-main handback loops, verify each handback against gh pr view's live head, reply once with git evidence to stale verdicts, hold instead of speculatively rebasing when main keeps moving, and rebase only onto the maintainer's explicitly mailed successor SHA.
tags: [delivery, coordination, git, maintainer]
timestamp: 2026-07-26
---

# Lesson

Maintainer handback loops can become mergeability-only races when current main
moves between product-approved handbacks. PR #44 took six mergeability rounds
after product approval from concurrent PR merges plus the maintainer's own
stewardship commits advancing main after every return.

This is a narrower delivery case of [crossed mail coordination](/lessons/crossed-mail-coordination.md): treat mail and named heads as evidence to verify against the live repository state, and treat explicit hold instructions as coordination constraints rather than invitations to keep chasing `origin/main`.

# Pattern

- **Verify every incoming verdict against the live PR head before acting.** Run
  `gh pr view <n> --json headRefOid`; in PR #44, four maintainer mails
  described heads already superseded by crossing pushes. Each stale verdict gets
  exactly one reply with fresh command outputs (`headRefOid`, merge-base,
  mergeable), not a re-push.
- **Rebase only onto the exact SHA the maintainer mails.** Do not rebase onto
  whatever `origin/main` has advanced to beyond that SHA, and never
  speculatively rebase while a "wait for my follow-up SHA" instruction stands.
  Holding broke the crossed-round cycle; eager rebasing extended it.
- **Make each handback self-contained.** Include the new head SHA, merge-base
  with `origin/main`, merge-delta summary, gate result, and any requested
  exact-head CI status in one message.
- **Union append-only `log.md` conflicts.** The recurring conflict in PR #44 was
  soul knowledge `log.md`; resolve by keeping both deliveries' entries
  newest-first under the same date heading, then run strict `validate:okf` as
  proof.
- **Fetch main immediately before opening a PR.** A stale local `origin/main`
  ref at branch-cut time can make the PR range look like it contains unrelated
  base commits. Fix branch scope drift with plain `git fetch` plus rebase.
- **Gate mechanical rebase or stewardship commits before pushing.** They do not
  need a post-commit reviewer, but still require the expected gate on the
  committed tree.
