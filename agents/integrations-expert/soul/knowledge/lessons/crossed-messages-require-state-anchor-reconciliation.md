---
type: Lesson
title: Crossed coordination messages require state-anchor reconciliation
description: Before repeating destructive branch instructions from delayed asynchronous messages, compare their stated head and open action with the current remote and latest coordinator ruling.
tags:
  - coordination
  - git
  - messaging
timestamp: 2026-07-26
---

# Crossed coordination messages require state-anchor reconciliation

During a fast multi-round integration, delayed mail repeatedly arrived after the requested reset, rebuild, fix, or gate had already completed. Acting on each message as current caused one unnecessary local rebuild, although it was caught before push.

For asynchronous instructions that can rewrite history or duplicate work:

1. Read the message's state anchor: expected base, branch head, reviewer round, and named open action.
2. Compare it with local `HEAD`, the tracked remote head, and the latest verified coordinator message.
3. If the instruction is stale but the requested tree state already exists, reply with the current head and evidence rather than rerunning it.
4. If content is equivalent but commit identities differ, ask whether history identity matters before rebuilding.
5. Do not push an unnecessary rewrite; use explicit force-with-lease only when the coordinator authorizes a rebuild.
6. For synchronous chat saying the sender is waiting, answer immediately with the reconciliation before continuing work.

A concise "current truth" report should name the pushed head, base/merge-base, completed gates, and remaining action. This lets the coordinator collapse crossed threads without guessing which message won.
