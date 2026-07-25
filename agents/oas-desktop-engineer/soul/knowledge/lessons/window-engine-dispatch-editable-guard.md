---
type: Lesson
title: Window-level engine dispatch needs an editable-target guard
description: User-recorded bare-key bindings can fire from inputs and textareas through the shell window keydown listener, so shell engine dispatch must require a real modifier on editable targets.
tags: [desktop, keybindings, focus]
timestamp: 2026-07-25
---

# Lesson

Even when no `DEFAULT_KEYMAP` chord is a bare key, the shortcuts editor can
record one, such as `a` for a stage switch. The shell's window `keydown`
listener then dispatches the binding from an `input` or `textarea`, stealing
the typed character and, for stage switches, discarding an open spawn form
(review c2a09e8).

Guard the dispatch site, not only view handlers. `allowsEngineDispatch(e)` in
`renderer/view-keys.mjs` requires a real modifier (`Mod`, `Ctrl`, or `Alt`)
when `isEditableTarget(e.target)` is true; Shift-only still types text and must
not bypass the editable-target guard.

Keep the shell guard even alongside an engine-side guard. The shell-level check
preserves the invariant if an engine caller forgets to reject unmodified chords
from editable targets.

# Related concepts

- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
