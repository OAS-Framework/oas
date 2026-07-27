---
type: Lesson
title: Crossed mail coordination needs repository verification and single replies
description: In high-frequency coordinator mail loops, messages can describe stale states; verify actionable claims against git and live code, answer each unique item once with evidence and exact heads, and avoid multiplying corrections already in the recipient's inbox.
tags: [coordination, aweb, process]
timestamp: 2026-07-25
---

# Lesson

In a high-frequency coordinator mail loop, mail can arrive out of order and
report a state that is several merges old. Treat mail as a lagging view and the
repository as the source of truth.

# Pattern

- **Verify before acting.** Check every actionable "do X" or "state is Y" claim
  against `git fetch`, `merge-base --is-ancestor`, and live code greps before
  changing code or reporting status. A requested task may already be done, and
  an "already handled" claim may still miss an integrated blocker.
- **Reply once per unique item.** Answer with the evidence and exact head or
  chain being discussed. If a later stale echo re-asks the same item, do not
  re-send the correction; it is already in the recipient's inbox and another
  copy only multiplies the crossing.
- **Escalate once, clearly.** When a stale snapshot threatens shipping a known
  broken tree, send one explicit escalation and keep it in the current session's
  watch items until confirmed resolved.
- **Name heads, not descriptions.** Pin status mail to commit hashes. Phrases
  such as "your fix" or "the converged state" create drift when both sides are
  merging and mailing concurrently.
- **Route maintainer mergeability loops through hold discipline.** In
  stewardship-loop handbacks, follow the [maintainer mergeability loop
  lesson](/lessons/maintainer-handback-stewardship-race.md): verify verdicts
  against the live PR head, rebase only onto the explicitly mailed successor
  SHA, hold instead of speculatively rebasing while a "wait for my follow-up
  SHA" instruction stands, and answer stale crossed verdicts only once with git
  evidence.
