---
type: Concept
title: Color adaptation — adaptRgb luminance folding and solarized-light ANSI remap
description: Captured terminal colors are authored for dark backgrounds, so the panel's light theme remaps the 16 standard ANSI colors to the real Solarized palette and folds too-bright 24-bit colors down to a readable lightness ceiling while preserving hue.
tags: [oas-web, ansi, adaptRgb, solarized, theming, color]
timestamp: 2026-07-21
---

# The problem

The session/terminal surface renders `tmux capture-pane -e` output through a
small ANSI(SGR)→HTML converter. Those colors are authored for dark
terminals; on the light theme's solarized paper (`#fdf6e3`), bright
true-color text (e.g. pi's status lines) vanishes into the cream background.

# Two mechanisms (panel.html)

1. **16-color remap**: in light mode the standard ANSI classes map to the
   actual Solarized palette (red `#dc322f`, green `#859900`, blue `#268bd2`,
   …) instead of the dark-surface set.
2. **24-bit luminance folding** — `adaptRgb`:

```js
function adaptRgb(r, g, b) {
  if (document.documentElement.dataset.theme !== "light") return `rgb(${r},${g},${b})`;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum <= 0.55) return `rgb(${r},${g},${b})`;
  const f = 0.55 / lum; // fold toward readable-on-paper, keep the hue
  return `rgb(${Math.round(r*f)},${Math.round(g*f)},${Math.round(b*f)})`;
}
```

Anything brighter than the 0.55 relative-luminance ceiling gets its channels
scaled down proportionally — lightness clamped into the readable band, hue
preserved. It is hooked into the SGR `38;2;r;g;b` foreground branch. The dark
theme passes colors through untouched. (The intent is a readable band in
*both* directions — dark theme keeps dark-authored colors as-is; the light
theme pulls bright ones down; if a too-dark-on-dark case ever shows up, the
symmetric raise belongs in the same function.)

# Related invariants

- Theme toggling re-renders the session immediately so adapted colors apply
  without waiting for the next poll.
- Contrast was held to WCAG AA on the paper surfaces (body ink 9.9:1, muted
  `#657b83` 4.9:1) — keep that bar when touching theme tokens.
- The light chrome is deliberately "slightly solarised": base3 `#fdf6e3`
  surfaces, `#f3eddd` wash, warm borders; the session surface is genuine
  solarized-light with base01 ink.
