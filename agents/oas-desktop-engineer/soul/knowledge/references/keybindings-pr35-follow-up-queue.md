---
type: Reference
title: Keybindings PR 35 follow-up queue
description: Terminal record for the keybindings PR 35 delivery — merge 7f1e5a7 with final head 039458f, all blocker/important review findings closed, and one stale spawn-view comment left for a follow-up PR.
tags: [desktop, keybindings, follow-up]
timestamp: 2026-07-25
---

# Keybindings PR 35 follow-up queue

PR #35 (`feature/keybindings` → `main`) shipped the desktop keyboard-shortcuts
feature. It merged as `7f1e5a7`; the final feature head was `039458f`.

# Follow-up item

- Fix the stale comment in `packages/desktop/renderer/views/spawn.mjs` near line
  73: it still says `spawn.filter` and `spawn.brain` register as `stage:spawn`
  actions, but since `b7f1451` they register as `view:spawn` actions — a
  never-activated, window-dispatch-ineligible view context. This was the
  Reviewer-b7f1451 nit and should be a one-line follow-up PR.

# Closure record

No other findings were deferred. Every blocker or important finding from the
review rounds was fixed and re-reviewed clean before merge, with five
per-commit APPROVEs.

The dispatch model behind the stale comment is captured in
[First-class view defaults need dispatch-ineligible contexts](/lessons/first-class-view-defaults-window-dispatch-surface.md)
and [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md).
