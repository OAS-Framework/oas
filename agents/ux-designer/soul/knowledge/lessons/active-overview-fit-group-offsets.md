---
type: Lesson
title: Include group offsets on both axes when fitting clustered Active overview layouts
description: "Active overview fit math must include both left and top offsets for positioned .hier-group elements or lower cluster groups can be clipped/miscentered."
tags:
  - desktop
  - active-overview
  - hierarchy
  - layout
timestamp: 2026-07-25T13:30:00Z
---

# Lesson

The single-group hierarchy view kept its group at (0,0), so `fit()` could compute node extents with only the group left offset (`gx`). Clustered layouts introduce real `style.left` and `style.top` offsets on `.hier-group` containers. The fit extent calculation must add both `gx` and `gy` from `parentElement.style.left/top` to node positions; otherwise viewport math can clip or miscenter lower groups such as an Independent strip.

# Design implication

Any future Active overview change that positions `.hier-group` elements must keep `fit()` extent math in `packages/desktop/renderer/views/hierarchy.mjs` synchronized with both axes. This extends [Evolve the existing Active overview hierarchy view](/lessons/active-overview-hierarchy-reuse.md).
