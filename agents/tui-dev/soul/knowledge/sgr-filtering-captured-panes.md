---
type: Concept
title: SGR filtering of captured panes — capturedSgr and clipSgr
description: Previews come from tmux capture-pane -e with native colors, so the TUI keeps only SGR (color) sequences and strips every other escape and control byte, because a captured cursor-move or clear sequence would corrupt the pane's own frame.
tags: [control-pane, tmux, sgr, capture-pane]
timestamp: 2026-07-20
---

The live preview is `tmux capture-pane -p -e -J -t <session>:<window> -S -N`
(`capturePreview` in model.mjs). `-e` preserves the pane's native SGR colors —
that's the point of the preview — but it also means the captured text can
contain **arbitrary** escape sequences from the child program: cursor moves,
`\x1b[2J` clears, mode toggles. Rendering those verbatim would let the
captured session repaint or scramble the Control Pane's own frame.

So the TUI filters before rendering (tui.mjs):

- `capturedSgr(value)` keeps only CSI sequences ending in `m` (SGR), drops
  every other CSI sequence, stray `\x1b` bytes not starting an SGR, and
  control characters (while keeping `\n`).
- `clipSgr(value, width)` truncates to a visible-character width by walking
  tokens `(\x1b\[[0-9;:]*m|[^\x1b])` — SGR tokens cost zero columns — and
  always appends `RESET` so a captured color can't bleed into the card
  background/border that follows.

Contrast with `clean(value)` (strips ALL escapes — used for width measurement
and for plain-text fields like task/next) — pick the right one: `clean` for
metadata text, `capturedSgr`/`clipSgr` only for captured pane content.

The regression test asserts a preview containing `\x1b[31mhello\x1b[0m\x1b[2J`
renders the red `hello` but never emits `\x1b[2J`.

Note: this filtering is width-approximate — wide (CJK) glyphs count as one
column; a known acceptable limitation.
