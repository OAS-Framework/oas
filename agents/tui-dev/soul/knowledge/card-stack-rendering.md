---
type: Concept
title: Card stack rendering — buildCard, in-place expansion, variable-height scroll, rowMap
description: renderFrame builds every instance as a card (identity rail + title + next-action line), expands the selected card in place, scrolls by real card heights, and returns a rowMap from screen lines to card indices for mouse selection.
tags: [control-pane, tui, rendering, cards]
timestamp: 2026-07-20
---

The v3 UI is a single full-width stack of agent cards (no list+inspector
split). Per frame, `renderFrame(snapshot, state, columns, rows)`:

1. Builds **every** card once via `buildCard(row, ctx)`; each card is an array
   of full-width ANSI lines:
   - line 1: identity rail (2-cell block in the soul's hashed color, dimmed
     when idle) + tree guides + `●/○` + soul + instance name + meta (repo,
     runtime if not pi, role, age) + right-aligned branch chip;
   - line 2: `→ next-action` (from STATE.md `# Next`);
   - expansion (selected card only): either the live tmux capture
     (`previewMode`) or a details field list (task, progress, parent, context,
     home), bounded by `contentLines`;
   - a trailing gap line that carries the tree spine toward the next card.
2. **Scrolls by real card heights**: `heights = cards.map(c => c.length)` and
   a `while (topRow < selected && used(topRow, selected) > available) topRow++`
   loop guarantee the selected (taller) card is always fully visible. Do not
   assume fixed row heights anywhere.
3. Returns `{ text, rowMap, topRow, selected }`. **`rowMap`** maps each
   emitted screen line number → card index; the input handler resolves mouse
   clicks (`SGR mouse, button 0`) via `frame.rowMap.get(y - 1)`. If you add
   lines to the output, they must go through the rowMap loop or clicks will
   mis-target.

Zoom (`space`) bypasses the stack entirely via `zoomFrame` (full-screen live
view, empty rowMap). Selection is preserved across the 2.5s auto-refresh by
instance name (`refresh(keepName)`), not index — the constellation can reorder
as instances start/stop.

Tree guides come from constellation rows' `depth`/`ancestorsLast`/`last`
(see the constellation concept); `guides(row, "node")` draws the branch into
the card (`├─▸`/`╰─▸`), `guides(row, "pass")` continues the spine past it.
