---
type: Lesson
title: Crossed-mail freeze discipline
description: Under repeated HOLD/GO/HOLD cycles with out-of-order mail delivery, use state-report-and-freeze: report exactly what is pushed vs local, keep freeze-time fixes as local unpushed commits, and treat incoming instructions as possibly stale.
tags: [coordination, aweb, freeze-protocol, crossed-mail]
timestamp: 2026-07-27
---

# Crossed-mail freeze discipline: report exact state, hold fixes locally

The package-config delivery hit three crossed HOLD/GO mails. The working
posture was state-report-and-freeze, not compliance theater. Use the soul skill
`crossed-mail-freeze-discipline` when freeze/unfreeze instructions arrive out of
order or conflict with actions already taken.

What worked:

- On any HOLD arriving after action, do not undo solely to look compliant;
  report exactly what is pushed, local-but-unpushed, and uncommitted, then
  freeze at the named point. The coordinator can reconcile ledgers from the
  state dump.
- Reviewer findings arriving during a freeze are still actionable. Fix them as
  local unpushed commits that ride with the closing commit, keeping the frozen
  origin head stable for everyone else's verification.
- Treat every incoming instruction as possibly stale against reports already
  sent. If the mail's requested state is already the current state, action is nil
  and a reply is optional unless coordination requires an explicit ACK.
- Verify claims about moving heads yourself with commands such as
  `git merge-base --is-ancestor` plus fetch/log inspection; report the
  verification alongside the action.

This complements the stale-commit evidence posture in
[coordinator stale verification loops](/lessons/coordinator-stale-verification-loop.md).
