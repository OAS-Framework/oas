---
type: Lesson
title: Split tab-strip alignment moves real tab elements into per-pane groups
description: Grouping the desktop tab strip to match split panes needs a dedicated full-width pane row containing only moved real tab elements for split members, so controls and non-members cannot skew pane alignment.
tags: [desktop, splits, tabs, a11y]
timestamp: 2026-07-26
---

# Split tab-strip alignment moves real tab elements into per-pane groups

When the tab strip needs to align with split panes, move each split member's
existing `.tab` element into a `.tab-group` container in pane order. Do not clone
tabs or build a second per-pane header: one real chrome node per tab preserves
roving tabindex, `aria-selected`, `aria-controls`, close buttons, and each
trigger's `tabKeyAction` listener because those listeners ride with the node.

# Pane-to-group projection

For row-oriented splits, the pane-group flex container must have the same
full-width track as `#tabhost` and contain nothing except one group per split
pane. Put those groups in a dedicated full-width `#pane-tabs` row above the
ordinary tabbar row; split-control buttons and non-member tabs live below with
`flex: none`, so they cannot make pane groups divide only leftover width or drift
away from pane boundaries. Column-oriented splits cannot literally align with a
horizontal tab strip; map pane order top-to-bottom into group order left-to-right.

Keep a `pending > 0` split slot visible as an empty `aria-hidden` spacer group
over the placeholder pane. Non-member tabs remain in the ordinary tabbar row and
stay clickable; activating one covers the split.

# Gotchas proven by tests

- Moving the focused tab trigger between containers can drop DOM focus to
  `<body>`. Capture `document.activeElement` before regrouping and re-focus that
  node after projection.
- Projection must be idempotent. `projectTabStrip` can run from `activateTab`,
  which pane `pointerdown` triggers; re-inserting a node that is already in the
  right place can tear it out of the DOM mid-click.
- Ending the split must restore the strip in tab-creation order from the shell's
  entries list, not in the order that split groups happened to hold. Keep a
  DOM-equality regression for the non-split strip so split support does not
  rewrite ordinary tab rendering.
- Without a layout engine, JSDOM cannot prove pixel alignment. Pin the structure:
  the pane row has exactly one flex child per pane, each pane group gets
  `flex: 1 1 0`, and controls/non-member tabs are outside the pane row with
  `flex: none`.
- With hidden non-member panes still parked in `#tabhost`, JSDOM assertions for
  the first pane should compare relative document position of member panes and
  the placeholder, not `firstElementChild`.

# Related concepts

- [Split panes as flex-cell reprojection of existing tab panes](/lessons/split-panes-flex-reprojection.md)
- [Terminal focus follows user intent through activateTab's focusContent option](/decisions/terminal-focus-intent.md)
