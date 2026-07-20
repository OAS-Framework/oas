---
type: Lesson
title: Terminal theme inference for TUIs
description: Control Pane should infer light or dark backgrounds from the terminal with OSC 11, fall back to COLORFGBG, and swap whole semantic palettes rather than isolated colors.
tags: [tui, theme, osc11, control-pane, terminal]
timestamp: 2026-07-20
---

When implementing terminal theme inference for `oas pane`, treat the terminal as
the source of truth and keep rendering code theme-agnostic.

- **OSC 11** is the reliable query: write `\x1b]11;?\x07` with stdin in raw
  mode. Supporting terminals reply `\x1b]11;rgb:RRRR/GGGG/BBBB` with 16-bit
  hex per channel; take the top byte. Some terminals emit 8-bit values.
  Compute relative luminance as `0.2126R + 0.7152G + 0.0722B`; values over
  `0.5` mean a light background.
- **Timeout is mandatory**: non-supporting terminals never reply. Use a short
  timeout around 150ms, then fall back to `COLORFGBG` by reading the background
  index from `fg;bg`; background index `7` or `15` means light. Default to dark
  if neither source answers.
- Run detection before entering the alt screen and main input loop, reusing the
  same raw-mode stdin that the TUI will own.
- Keep a single semantic color object (`ink`, `muted`, `faint`, surfaces, and
  related roles) and swap it wholesale through `applyTheme(light)`. Derived
  styles such as soul badge text and feature-branch chip foreground/background
  must be filled from the same semantic palette, not patched per color.
- Grep for hardcoded `38;2;` and `48;2;` literals outside the palette after
  theme work; a leaked branch-chip literal was unreadable on a light background.
- Keep `parseOsc11` exported and pure for testability. The frame renderer should
  not need theme awareness.

This lesson complements the [Control Pane visual language](/decisions/control-pane-visual-language.md)
and [Control Pane v3 card architecture](/decisions/control-pane-v3-card-architecture.md)
decisions.
