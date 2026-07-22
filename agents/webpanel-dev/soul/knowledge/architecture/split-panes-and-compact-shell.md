---
type: Concept
title: Split panes, collapsible sidebar, and compact session header
description: v0.7.0 replaced the single session surface with per-pane session state in an editor-style split row, plus a persisted collapsible sidebar and 32px compact pane header.
tags: [oas-web, split-view, sidebar, header]
timestamp: 2026-07-22
---

# Split-pane shell

The panel shell uses an editor-style `#panes` container backed by a panes array.
Each pane owns its own session id, poll loop, renderer container, and
stale-response guards. One pane is logically focused at a time and receives
keyboard input through the global key router, even if DOM focus is on a pane
header or shell control.

Roster clicks replace the focused pane's session. Modifier-clicking a roster
entry opens a new split. Splits use an equal-width flex row; there is no
drag-resize behavior.

# Sidebar and header

The sidebar is collapsible via a toggle button, and the collapsed state is
persisted in `localStorage`.

The per-session header is a compact `.phead` row: about 32px tall, muted,
truncated typography with title tooltips. Keep this slim pane header rather
than restoring the taller `vhead` block.

# Related concepts

- Per-pane stale-response guards generalize the poller lesson in
  [Stale-response race in the chat poller](/lessons/stale-response-race.md).
- Focused-pane key routing relies on
  [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md);
  the DOM-focus regression is captured in
  [Route panel keyboard by logical pane focus, not DOM focus](/lessons/logical-key-routing-not-dom-focus.md).
