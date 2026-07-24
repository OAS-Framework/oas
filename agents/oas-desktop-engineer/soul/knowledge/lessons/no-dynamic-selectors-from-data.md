---
type: Lesson
title: Never interpolate data-derived identity into querySelector
description: Data-derived identity should be matched in JavaScript after a static querySelectorAll, because raw or fallback-escaped interpolation can throw or match the wrong node when names contain CSS metacharacters.
tags: [dom, selectors, safety, shadowing, renderer, review-lesson]
timestamp: 2026-07-24
---

# Never interpolate data-derived identity into querySelector

# The bug

A reviewed Spawn-view repaint guard tried to find the selected card by
interpolating the selected agent name into a CSS selector:

```js
grid.querySelector(`.soul-card[data-agent="${CSS.escape ? CSS.escape(s.sel) : s.sel}"]`)
```

Review of `37a60fb` found two stacked failures:

1. The module declared `const CSS = \`...\`` for its stylesheet, shadowing the
   global `CSS` object. `CSS.escape` was therefore always undefined in that
   scope, so the raw-interpolation fallback always ran.
2. An agent name containing selector metacharacters such as `bad"name` then
   threw `SyntaxError: Invalid selector` on every render. Other crafted names
   could make the selector match the wrong node.

# Safer pattern

Avoid dynamic selectors for data-derived identity. Query a static node set and
compare identity in JavaScript:

```js
[...grid.querySelectorAll(".soul-card")].some(
  (card) => card.dataset.agent === s.sel && card.querySelector(".soul-form"),
)
```

This pattern needs no escaping, cannot throw because of the agent name, and
cannot be redirected by selector syntax inside data. If a dynamic selector is
truly unavoidable, avoid shadowing the global `CSS` object and use the real
`CSS.escape` without any raw-data fallback; a fallback that interpolates raw data
defeats the escape.

# Regression pattern

Use an agent name with `querySelector` metacharacters, such as `bad"name`. It
must open its form without throwing, preserve the poll-repaint barrier while the
form is open, and spawn with the task and exact agent name in the POST body.

# Related

- [Periodic repaints must not rebuild DOM under open forms](/lessons/poll-repaint-wipes-form-input.md) is the open-form repaint lesson whose original selector guard was superseded by this safer pattern.
