---
type: Concept
title: Theme inference — OSC 11 query, luminance threshold, COLORFGBG fallback
description: At startup the TUI asks the terminal its background color via OSC 11 in raw mode with a 150ms timeout, classifies light vs dark by relative luminance > 0.5, falls back to COLORFGBG (bg 7 or 15 means light), and defaults to dark.
tags: [control-pane, theme, osc11, terminal]
timestamp: 2026-07-20
---

`startControlPane` calls `applyTheme(await detectLightTerminal())` **before**
entering the alt screen. The mechanism (same approach as vim/delta/lazygit):

1. Write `\x1b]11;?\x07` to stdout with stdin in **raw mode**, listening for
   the reply. The reply must be consumed on stdin or it leaks into the UI as
   garbage input.
2. `parseOsc11(response)` (exported, pure — unit-testable) matches
   `]11;rgb:RRRR/GGGG/BBBB` where each channel is 2–4 hex digits (xterm
   replies in 16-bit form, 4 digits); only the top byte is used
   (`hex.slice(0, 2)`). Classification: relative luminance
   `0.2126r + 0.7152g + 0.0722b > 0.5` → light. Returns `undefined` for
   garbage so the caller can fall back.
3. A **150ms timeout** caps the wait — terminals that don't answer OSC 11
   (or non-TTY stdin/stdout) must never stall launch. On timeout/non-TTY,
   fall back to `COLORFGBG` ("fg;bg"; bg `7` or `15` = light), else dark.

`applyTheme(false)` runs at module load so the palette is populated even if
detection is skipped (e.g. `renderFrame` called from tests without a TTY).

Test shapes worth preserving (in `test/control-pane-model.test.mjs`): xterm
16-bit form with BEL terminator, ST (`\x1b\\`) terminator, 8-bit two-digit
form, and garbage → `undefined`.
