---
type: Lesson
title: Reviewer deaths can come from tmux prefix-target kills
description: A reviewer that stops cleanly mid-turn and loses its tmux window was likely killed externally; check delayed mail first, then spawn a fresh one-shot reviewer and retire the dead instance.
tags: [review, tmux, coordination]
timestamp: 2026-07-23T00:30:00Z
---

# Lesson

During feature/desktop-app, several reviewer instances died mid-review. Their
pi session JSONL simply stopped after a successful tool result and their tmux
windows vanished from `pi-agents`. That signature — clean mid-turn stop plus a
missing window — indicated an external kill rather than an agent crash.
Developers waiting on verdict mail then deadlocked.

The root cause was fixed on main in commits `b3eeed0` and `0753b40`:

1. tmux `-t session:window` targets prefix-match. `kill-window -t
   s:reviewer-1` can kill `reviewer-15cXXXX` when no exact `reviewer-1`
   exists.
2. The repo test suite retired fixture instances named `reviewer-1` against
   the real `pi-agents` session, so `npm test` could kill a live `reviewer-*`
   window.
3. A bare `node --test` could recurse into `agents/*/instances/*/work` sibling
   worktrees holding stale copies of the unanchored test until test-runner
   globs were pinned.

The suspected unscoped `pkill -f` from another project was a red herring for
this incident, though still bad hygiene.

Durable coordinator rules:

- tmux `-t` targets must be exact-anchored (`=session:=window`) with component
  validation in product code and agent-authored tmux scripts.
- Tests that exercise spawn/retire must override `tmuxSession` to a
  nonexistent name, and test-runner globs must not recurse into embedded
  worktrees.
- `display-message -p -t <missing>` can fall back to a default context; use
  `list-panes` when a missing exact target must fail closed.
- For a suspected dead reviewer, check `aw mail inbox --show-all` before
  acting because awakening events can lag behind mail. If the reviewer really
  died, unblock the waiter by asking it to spawn a fresh reviewer on the same
  commit; reviewers are one-shot and should not be resumed.
