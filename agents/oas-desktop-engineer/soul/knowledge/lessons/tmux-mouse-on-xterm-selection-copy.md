---
type: Lesson
title: tmux mouse-on viewers need modifier-forced xterm selection for copy
description: With viewer tmux sessions running `mouse on`, plain drags are forwarded to tmux instead of building an xterm selection; enable `macOptionClickForcesSelection` so Option+drag on macOS, or Shift+drag elsewhere, can force a local xterm selection for Copy.
tags: [desktop, xterm, tmux, copy, selection]
timestamp: 2026-07-25
---

# tmux mouse-on viewers need modifier-forced xterm selection for copy

The v0.18.4 copy fixes for transcript repaint deferral, edit menu plumbing,
and `user-select` CSS did not cover the terminal surface. Desktop viewer tmux
sessions set `mouse on` so wheel scrollback works. With tmux mouse events active,
xterm.js forwards plain click-drag input to tmux instead of constructing a local
xterm selection, so Cmd+C or the Copy menu has no xterm selection to copy.

This is distinct from tmux copy-mode: tmux's own selection cannot reach the
system clipboard through the desktop terminal unless xterm.js handles the OSC52
clipboard path, and the current terminal surface does not add that clipboard
addon.

# Fix pattern

Let xterm.js keep its own local selection for copy, but expose the escape hatch
that still works while tmux mouse mode is active:

- enable `macOptionClickForcesSelection: true` in the terminal options;
- on macOS, use Option+drag to force an xterm selection;
- on non-mac platforms, Shift+drag is xterm's built-in forced-selection chord;
- copy via the app's normal Cmd+C / Copy menu path.

An xterm selection is internal to xterm.js, not a DOM selection: `window.getSelection()`
can remain empty while the terminal still copies through xterm's copy handler
and browser clipboard path. Treat an empty DOM selection as expected for the
terminal surface, not proof that copy is broken.

Keep terminal option construction in an exported helper (for example,
`terminalOptions`) and test source consumption at the layer that instantiates
xterm. This follows the regression-test rule that a copy fix must exercise the
layer that had the bug, not only a helper in isolation.

# Related concepts

- [Polling innerHTML repaints destroy text selection](/lessons/polling-innerhtml-repaints-destroy-selection.md) covers transcript copy failures caused by DOM repainting; terminal copy uses xterm's internal selection model instead.
- [Provision locked tmux key tables as explicit allow-lists](/lessons/provision-locked-key-tables.md) covers why tmux viewer keyboard/mouse behavior must preserve intended terminal affordances.
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md) covers the source-consumption test shape for terminal options.
