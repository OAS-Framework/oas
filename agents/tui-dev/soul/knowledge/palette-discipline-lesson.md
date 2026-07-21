---
type: Lesson
title: Hardcoded SGR color literals outside the palette break light mode
description: Every color in the TUI must come from the theme-owned palette objects filled by applyTheme; a single hardcoded 38;2/48;2 literal (like the original purple feature-branch chip) leaks the dark design onto light backgrounds and becomes unreadable.
tags: [control-pane, theme, palette, lesson]
timestamp: 2026-07-20
---

When theme inference was added, the TUI's colors were refactored from a
`const C = { ink: "\x1b[38;2;..." }` literal into a **mutable** `C` object plus
`SOUL_PALETTE` and `BADGE_TEXT`, all filled by `applyTheme(light)` swapping
**whole semantic palettes** (ink/muted/faint text, panel/card/selected/bar
surfaces, accents, six soul-identity colors, badge text).

The bug found during that work: `branchChip` had literal
`\x1b[48;2;64;46;96m` / `\x1b[38;2;204;170;255m` for the feature-branch chip —
a purple designed for the dark surface that would have been unreadable on
white. It had to become `C.featureBranchBg` / `C.featureBranchFg`, defined in
both palette branches.

**The rule**: in `tui.mjs`, never emit a raw `38;2`/`48;2` literal at a call
site. Every color, including one-off accents, gets a semantic name in `C` (or
`SOUL_PALETTE`/`BADGE_TEXT`) with a value in **both** the light and dark
branches of `applyTheme`. A quick audit before shipping:

```bash
grep -n '38;2\|48;2' lib/control-pane/tui.mjs   # matches should only be inside applyTheme
```

Related web-panel lesson (same root cause, different surface): captured
24-bit colors from tmux are authored for dark backgrounds; the oas.web panel
had to clamp captured-color luminance in both directions (lift too-dark on
dark surfaces, fold too-bright on light) to stay readable. If the TUI ever
adapts captured colors per theme, expect the same two-sided clamp.
