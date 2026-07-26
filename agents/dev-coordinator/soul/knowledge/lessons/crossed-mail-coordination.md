---
type: Lesson
title: Crossed aweb mail dominates multi-dev integration churn — anchor every mail on exact heads
description: In a fast two-developer loop, most coordination rounds were resolving stale crossed mail; stating exact commit heads, what is already merged, and a single explicit next action in every mail is the effective countermeasure, plus declaring a hard freeze once PR-ready.
tags: [coordination, aweb, integration, multi-dev]
---

# Crossed mail dominates fast multi-dev loops

During the keybindings feature, a large fraction of coordinator mails resolved CROSSED state: developers acting on stale signals, or coordinator routing findings already fixed.

What worked:

- Every mail states the exact feature-branch head, what of the recipient's branch is already merged, and exactly one next action.
- When a mail arrives referencing stale state, don't re-litigate. Reconcile against git with merge-base or ancestor checks, then reply with current truth.
- Once PR-ready, declare an explicit HARD FREEZE: per-commit reviewer findings keep arriving, and each valid-but-non-critical fix moves the head past approved state. Only blocker-class defects get commits; the rest is follow-up-PR material. Developers complied immediately once the rule was explicit: relay verdicts, act only on coordinator go.
- Accept genuine blockers even past the freeze, and notify the mid-review maintainer at once with the precise delta.
