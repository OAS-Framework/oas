---
type: Lesson
title: Palette subsequence scorer's no-match sentinel must be out-of-band
description: The palette fuzzy scorer can return negative scores for strong prefix matches, so no-match must be represented with null rather than a comparable numeric sentinel.
tags: [desktop, palette, quick-open, fuzzy]
timestamp: 2026-07-26
---

While extracting the palette subsequence scorer into `renderer/overlay-picker.mjs` for Quick Open, tests exposed a legacy scorer bug: `-1` represented no match, while prefix bonuses made good prefix matches score as `gaps - 100`. Callers filtered with `if (sc < 0 && q) continue` or `if (sc < 0) continue`, so an exact prefix query such as `>theme` against "Theme: toggle" was silently dropped as a non-match.

# Rule

A fuzzy scorer that subtracts bonuses from numeric scores must not reserve an in-band numeric value for no-match. Return `null` for no match and treat every number, including negative numbers, as a valid score. Callers should filter with `sc == null`, not `sc < 0`.

# Related concepts

- [Shell nav reachability needs an importable manifest](/lessons/shell-nav-reachability-manifest.md)
