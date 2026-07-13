---
type: Playbook
title: Iterate on Control Pane visuals with a mock render script
description: Use a fabricated Control Pane snapshot to iterate on TUI layout without spawning live agents.
tags: [control-pane, tui, testing]
---

# Playbook

The Control Pane renderer can be exercised without live agents because
`renderFrame(snapshot, state, columns, rows)` in `lib/control-pane/tui.mjs` is a
pure renderer and the tree is built by `buildConstellation(instances)` from
`lib/control-pane/model.mjs`.

To iterate on visual design:

1. Write a small script that fabricates a `snapshot`, including instances with
   fields such as `agent`, `instance`, `parentInstance`, `git`, and `next`.
2. Call `buildConstellation` with the fabricated instances, then call
   `renderFrame` with the snapshot, state, columns, and rows.
3. Print the frame text.
4. Drive geometry with environment variables such as `COLS` and `ROWS`, and use
   an argv index for selection.
5. Run the script in a real terminal to see colors.
6. Pipe output through `sed 's/\x1b\[[0-9;]*m//g'` when checking alignment or
   wrapping without SGR noise.
7. Test both wide layouts — at least 96 columns for the two-panel view — and
   narrow layouts.

# Gotchas

- The row-height constant, meaning lines per instance row, appears in three
  places: `listPanel`, `renderFrame`'s `maxVisible`, and `keepVisible` inside
  `startControlPane`. Keep them in sync.
- A globally installed `oas` can be an npm-link symlink into the framework
  checkout, so Control Pane source edits may be live on the next `oas pane`
  invocation without a reinstall.

This playbook supports the [Control Pane visual language](/decisions/control-pane-visual-language.md).
