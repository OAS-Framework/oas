---
type: Lesson
title: Typing must force-repaint and pin the prompt row
description: Keys can reach tmux while the panel still appears unable to type if the UI does not force a terminal repaint and snap to the bottom row after input; key flushes should force a short-tail refresh and pin the prompt briefly.
tags: [oas-web, scroll, echo, regression, verification]
timestamp: 2026-07-22
---

# The real failure

The reopened "cannot type" bug was not another key-routing failure. The human
clarified that typing was reaching tmux but was not visible in the panel.

Two UI behaviors made the echo disappear:

1. Post-keystroke refresh used a non-forced `refreshTerm(p, false)`, so an
   unchanged render signature or a scrolled-up viewport could leave the view
   stale.
2. Bottom pinning only applied when already near the bottom; typing while
   scrolled into history left the prompt row out of view.

# Fix pattern

Typing means "show me the prompt". Each key flush sets `p.snapUntil = now + 2s`
and calls a forced terminal refresh. While `snapUntil` is live, every repaint,
including the normal pollers, pins `scrollTop = scrollHeight` so the prompt row
stays visible.

The first visibility fix used the deep 2000-line fetch for every key flush and
felt laggy. Keystroke echo should use the smallest capture that contains the
prompt row: `refreshTerm(p, true, 120)`. Deep scrollback can return on the
regular poll after the typing window. With the tail refresh and coalescing, the
measured median keydown-to-echo path was about 33ms headlessly.

# Process rules

- Do not close a human-reported bug on local repro/tests alone; run the fix on a
  dev port and have the human confirm.
- When a report says "X does not work", ask what the user sees before modeling
  the cause. In this case, "cannot type" meant "cannot see my typing".

# Related concepts

- [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md)
- [Route panel keyboard by logical pane focus, not DOM focus](/lessons/logical-key-routing-not-dom-focus.md)
- [Fast attach needs cached instance lookup and staged terminal paint](/lessons/fast-attach-cache-tail-backfill.md)
