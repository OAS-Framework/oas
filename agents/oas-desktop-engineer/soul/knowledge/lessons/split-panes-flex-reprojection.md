---
type: Lesson
title: Split panes as flex-cell reprojection of existing tab panes
description: Desktop split panes were implemented by toggling member tab panes into flex cells of #tabhost with a pure split-layout model, so tab identity/dedup and each tab's ResizeObserver-driven FitAddon refit stayed untouched.
tags: [desktop, renderer, splits, terminal]
timestamp: 2026-07-26
---

# Split panes as flex-cell reprojection of existing tab panes

For the split-panels feature (branch oas-desktop-engineer/split-panels), the
cheapest correct design was NOT a separate pane tree: keep tabs as the single
source of terminal identity and make a split a pure state object
`{ orientation, members: [tabId], pending }` (renderer/split-layout.mjs).
The shell projects it in `activateTab`: member panes get `.active` +
`.split-cell` and `#tabhost` gets `display:flex` row/col.

Why this preserved the earned invariants for free:

- **Identity/dedup untouched**: the pending split slot absorbs the NEXT
  terminal tab activated through the normal open path (sidebar/palette →
  resolveTerminalOpen → addTab), so a split can never host an unresolved or
  duplicate identity.
- **FitAddon refit for free**: terminal-tab.mjs's ResizeObserver fires on any
  pane resize, but its fit gate is `isActive() = paneEl.classList.contains("active")`
  — split members must keep `.active` (shown = selected || inSplit) or hidden
  members never refit. `aria-selected`/tabIndex stay single-selection.
- **Cleanup**: `removeSplitTab` collapses to `null` (single pane) below two
  panes; workspace switch nulls the split because members are
  workspace-scoped terminal tabs.

CSS gotcha: `.tab-pane` is `position:absolute; inset:0` — split cells must
override with `position:relative; inset:auto; flex:1 1 0; min-width/height:0`
or flex sizing does nothing.
