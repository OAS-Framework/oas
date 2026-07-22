---
type: Lesson
title: Scope every pkill during live desktop testing
description: Broad `pkill -f` patterns during app testing can kill foreign processes machine-wide — always scope patterns to your own worktree path or exact PIDs; an unscoped `pkill -f "oas-web.mjs start"` from another process killed/restarted servers it did not own.
tags: [testing, pkill, tmux, incident, discipline]
timestamp: 2026-07-22
---

During the desktop-app live-testing rounds a coordinator incident question
(an externally killed reviewer tmux window) prompted an audit of my process
cleanup. My own habits held up — every `pkill -f` was scoped to my worktree
path (`work/packages/desktop`) and server kills used exact PIDs — but I
observed an unrelated process run `pkill -f "oas-web.mjs start"` UNSCOPED,
which kills every matching process for every user context on the machine.

Rules distilled:
- Never `pkill -f` a pattern that could match processes outside your own
  tree; include your worktree path in the pattern or use exact PIDs
  captured at spawn time.
- Terminal viewers must only ever kill their own pty (tmux client detach);
  `tmux kill-window`/`kill-session` on sessions you did not create is
  forbidden — the only session I ever killed was my own scratch
  (`oasdesktest`).
- Keep test artifacts timestamped (log files, script mtimes) — they are
  the evidence that clears (or implicates) you when an incident window is
  being reconstructed.
