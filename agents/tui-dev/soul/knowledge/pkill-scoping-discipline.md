---
type: Lesson
title: Scope destructive cleanup during live desktop testing
description: Broad `pkill -f` patterns and unanchored tmux targets during app testing can kill foreign processes machine-wide — always scope patterns to your own worktree path, exact PIDs, or exact tmux targets.
tags: [testing, pkill, tmux, incident, discipline]
timestamp: 2026-07-23
---

During the desktop-app live-testing rounds a coordinator incident question
(an externally killed reviewer tmux window) prompted an audit of my process
cleanup. My own habits held up — every `pkill -f` was scoped to my worktree
path (`work/packages/desktop`) and server kills used exact PIDs — but I
observed an unrelated process run `pkill -f "oas-web.mjs start"` UNSCOPED,
which kills every matching process for every user context on the machine.

The incident endgame also found tmux prefix matching in reviewer cleanup:
`kill-window -t s:reviewer-1` can target a `reviewer-15c*` window unless the
target is anchored with `=`. The fix was on main at `b3eeed0`, but reviewers
run the code in their current worktree; merge the fix into that worktree
before relying on it. Until every active worktree has the anchored-target fix,
avoid reviewer purposes whose tmux window name is an extension of any test
fixture name.

Rules distilled:
- Never `pkill -f` a pattern that could match processes outside your own
  tree; include your worktree path in the pattern or use exact PIDs
  captured at spawn time.
- Terminal viewers must only ever kill their own pty (tmux client detach);
  `tmux kill-window`/`kill-session` on sessions you did not create is
  forbidden — the only session I ever killed was my own scratch
  (`oasdesktest`).
- When a tmux destructive command is unavoidable, use exact `=`-anchored
  targets and remember that a main-branch fix does not protect stale reviewer
  worktrees.
- Keep test artifacts timestamped (log files, script mtimes) — they are
  the evidence that clears (or implicates) you when an incident window is
  being reconstructed.
