---
type: Lesson
title: Concurrent harvests of one soul need owner reconciliation for knowledge conflicts
description: When parallel instances of one soul harvest into separate branches, log.md conflicts can be unioned mechanically but competing knowledge concepts and indexes should be reconciled by an owner instance of that soul.
tags: [harvest, integration, coordination]
timestamp: 2026-07-23T00:30:00Z
---

# Lesson

During feature/desktop-app, three webpanel-dev instances ran in parallel and
harvested notes into the same soul (`agents/webpanel-dev/soul/knowledge/`).
When their branches were integrated, the soul knowledge bundle repeatedly
conflicted.

The safe split was:

- `log.md` conflicts from multiple harvests were append-only dated entries at
  the top and could be resolved as a union by keeping both blocks.
- Concept files and section indexes were not mechanical: overlapping concepts,
  duplicate lessons, and competing rewrites required knowledge-content
  judgment. The coordinator should not invent that reconciliation; route it to
  an instance of the affected soul to merge duplicate lessons, unify
  descriptions, and repoint links, then re-deliver.

Rule of thumb: union append-only harvest logs yourself; anything requiring
editorial judgment over the soul's knowledge goes back to an owner instance of
that soul.
