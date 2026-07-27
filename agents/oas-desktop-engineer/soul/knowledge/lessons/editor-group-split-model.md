---
type: Lesson
title: Editor-group split model replaces the pending-slot arrangement
description: Reworking desktop splits to VS Code semantics meant moving the split from a per-tab arrangement to a persistent tab-layer model of groups each owning tabs and an active tab, with new tabs opening into the focused group and per-group tab strips replacing the shared strip row.
tags: [desktop, splits, editor-groups, renderer]
timestamp: 2026-07-27
---

# Editor-group split model replaces the pending-slot arrangement

Human feedback on the shipped split (PRs #41/#44): an empty phantom chrome
row appeared under the tabs, the split vanished when switching tabs, and new
tabs did not open into the current split. The fix was a model change, not a
patch: splits became VS Code editor groups.

Key design decisions (branch agents/oas-desktop-engineer-editor-groups):

- Model: `null | { orientation, nextId, groups: [{ id, tabs, activeTab }], focusedGroup }`
  in split-layout.mjs. Group ids are model-local monotonic keys so DOM cells
  keep stable `data-group` identity across re-renders.
- The first split seeds group 1 with ALL current-workspace terminal tabs
  (human requirement: "all tabs that were in the original split should remain
  there") and creates an empty FOCUSED group (VS Code: the new group is
  active). The old pending-slot "absorb next terminal" indirection was
  dropped — an empty focused group + `openTabInFocusedGroup(model, id)` on
  every terminal-tab entry does the same job with no special pending state.
- `activateTab` routes members through `focusTab` (group activeTab + focus)
  and new terminal tabs through `openTabInFocusedGroup` — so EVERY open path
  (roster, palette, quick-open) lands in the focused group with identity
  resolution/dedup untouched.
- Post-review blocker (ddbbe3b): after `requestSplit` focuses the new empty
  group, `splitPane`'s re-render must call
  `activateTab(activeTab, { keepGroupFocus: true })`. The default member path
  calls `focusTab`, which would snap `focusedGroup` back to the source group;
  then the next terminal opens in the original group and the empty group is
  unreachable. Regression coverage must replay the real
  `splitPane` -> `activateTab` -> open sequence, not only the split model in
  isolation.
- Split visibility = `!!split && activeTab.kind === "terminal"` — switching
  tabs never dismantles the split; non-terminal tabs merely cover it.
- Per-group chrome: each `.group-cell` holds a `.group-tabbar` tablist with
  the group's REAL tab elements (one chrome per tab keeps tab-a11y) and the
  group's panes; `#tab-actions` rides the FOCUSED group's strip. The top
  `#tabstrip` is hidden while split — keeping it was exactly the reported
  phantom empty bar.
- Byte-identical flat restore needed two subtleties: `classList.toggle(x,
  false)` materializes `class=""` on class-less elements (guard + remove the
  attribute when empty), and moving `#tab-actions` out needs a Comment
  marker to restore it into the exact whitespace slot. Pinned with an
  `outerHTML` equality regression.
- Close successor is model-owned: `removeSplitTab` returns
  `{ split, successor }` — adjacent tab IN THE GROUP, else the neighbor
  group's active tab when the group collapses; still beats the generic
  most-recent fallback (156cbc7 lineage preserved).

# Related concepts

- [Split panes as flex-cell reprojection of existing tab panes](/lessons/split-panes-flex-reprojection.md) (superseded model)
- [Split tab-strip alignment moves real tab elements into per-pane groups](/lessons/split-tab-strip-real-tab-groups.md) (superseded strip approach)
