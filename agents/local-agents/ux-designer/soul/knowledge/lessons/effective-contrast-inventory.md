---
type: Lesson
title: Validate effective contrast across shipped style sources
description: "Token-pair contrast tests are insufficient when opacity, fallbacks, or JavaScript theme fields create untracked effective colors."
tags:
  - accessibility
  - contrast
  - theming
  - testing
timestamp: 2026-07-24T10:35:50Z
---

# Lesson

Mathematical WCAG checks must inventory every foreground actually shipped in CSS and JavaScript, then validate it against every surface on which it appears. Testing only a hand-picked token table misses effective colors created by container opacity, `color-mix()` text, raw fallbacks, and xterm theme fields.

# Practice

- Use opaque semantic foreground tokens; avoid text/container opacity.
- Reject raw, fallback, and derived foreground declarations in shipped sources.
- Inventory recursive CSS and renderer JavaScript, including xterm fields.
- Define explicit selection foreground and background tokens; selection background alone does not prove contrast.
- Validate dark and light themes against the effective foreground/surface matrix.

# Observed consequence

Opacity can make the source token pass while the composited text fails. JavaScript fallbacks can bypass a CSS-only inventory. Automated source inventory turns both into test failures rather than visual-review guesses.
