---
type: Decision
title: Named themes replace terminal theme inference
description: The pane no longer guesses the terminal background (OSC 11 / COLORFGBG removed). It ships two named themes — dark (default) and solarized (Solarized Light) — selected explicitly via `oas pane --theme` or OAS_PANE_THEME.
tags: [control-pane, theme, decision]
timestamp: 2026-07-21
---

Decision (maintainer, 2026-07-21): terminal-background **guessing is removed**.
The OSC 11 raw-mode query + COLORFGBG fallback (see git history of
`theme-inference-osc11.md`) was fragile across terminals/muxers and produced
surprising palettes. Instead:

- `THEMES = ["dark", "solarized"]` exported from `lib/control-pane/tui.mjs`.
- `dark` is the default; `solarized` is Solarized Light (Schoonover palette:
  base3/base2 surfaces, base00 ink, standard accent colors).
- Selection: `oas pane --theme <name>`, or `OAS_PANE_THEME` env; `--theme`
  wins. Unknown names error loudly before the alt screen.
- `applyTheme(name)` takes the theme name, not a boolean.
- `parseOsc11`/`detectLightTerminal` are deleted — do not reintroduce
  detection without a maintainer decision.

Adding a theme = a new palette block in `applyTheme` + the name in `THEMES`
+ docs (`docs/control-pane.md`).
