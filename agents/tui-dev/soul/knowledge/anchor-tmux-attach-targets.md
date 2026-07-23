---
type: Lesson
title: Anchor every tmux target the desktop constructs
description: tmux prefix-matches unanchored targets even for attach-session, so desktop code must build `=session:=window` through a validating helper and fail loudly when the exact window is gone.
tags: [tmux, desktop, terminal, security, exact-match]
timestamp: 2026-07-23
---

`tmux -t session:window` is not exact. Prefix matching applies to
`attach-session` as much as destructive commands: if roster data is stale and
the intended window is gone, tmux can attach a desktop terminal to a similarly
named live window. That routes user keystrokes into the wrong agent instead of
showing the renderer's existing "could not attach" banner.

The desktop terminal path in [Desktop terminal is a direct tmux attach via
node-pty](desktop-terminal-direct-attach.md) should construct attach targets
with `tmuxAttachTarget(session, window)` in `packages/desktop/tmux-target.mjs`.
The helper validates both components with a conservative charset that rejects
`:` and `=` (tmux target syntax) and returns `=session:=window`.

Regression coverage should prove live tmux behavior, not just string shape: with
only window `reviewer-15c135c` present, an anchored target for `reviewer-1` must
be refused while the exact window name resolves.

# Rule

Every tmux `-t` target constructed by the desktop — attach, kill, list, or send
— should be `=`-anchored and component-validated. When touching tmux code, grep
for constructed `-t` arguments that lack `=` anchoring; failures should be loud
(tmux "can't find window", then the existing renderer banner), never silent
mis-attachments.
