---
type: Decision
title: Flat card surface — no per-card background blocks
description: Cards share the panel background in both themes; only the selected card gets a subtle background step and the identity rail carries the soul color. Feature-branch chips are colored text, not filled blocks.
tags: [control-pane, theme, cards, decision]
timestamp: 2026-07-22
---

Decision (maintainer, 2026-07-22, after real-terminal feedback): per-card
background blocks looked like arbitrary colored slabs in both themes —
full-width `C.card` fills read as visual noise rather than structure.

- `C.card === C.panel` in both themes: an unselected card is distinguished
  by its soul-colored identity rail, the ● live marker, and typography —
  not by a background fill.
- Only the **selected** card gets a background step (`C.selected`, one
  subtle shade off the panel: base2 on solarized, `rgb(30,34,50)` on dark).
- The feature-branch chip is colored bold text (violet), not a filled
  `bg+fg` block; `featureBranchBg/Fg` tokens are gone.
- The bar rows (header/footer) keep their own background — they frame the
  surface; cards do not.

Do not reintroduce card fills without maintainer sign-off; if more visual
separation is needed, prefer whitespace (the existing gap rows) or rail
styling over background blocks.
