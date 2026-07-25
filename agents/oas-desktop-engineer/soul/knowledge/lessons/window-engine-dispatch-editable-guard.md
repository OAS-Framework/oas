---
type: Lesson
title: Window-level dispatch guards were transitional shell responsibilities
description: Before the engine owned editable-target rejection, shell window dispatch needed allowsEngineDispatch; after matchEvent internalizes it, delete the shell copy instead of keeping duplicate guard semantics.
tags: [desktop, keybindings, focus]
timestamp: 2026-07-25
---

# Lesson

Even when no `DEFAULT_KEYMAP` chord was a bare key, the shortcuts editor could
record one, such as `a` for a stage switch. Before the engine owned the policy,
the shell's window `keydown` listener could then dispatch the binding from an
`input` or `textarea`, stealing the typed character and, for stage switches,
discarding an open spawn form (review c2a09e8).

That originally forced a shell guard: `allowsEngineDispatch(e)` in
`renderer/view-keys.mjs` required a real modifier (`Mod`, `Ctrl`, or `Alt`)
when `isEditableTarget(e.target)` was true; Shift-only still typed text and did
not bypass the editable-target guard.

# Superseded contract

Once `matchEvent` gained the `defaultPrevented` skip and editable-target check,
the shell-side `allowsEngineDispatch`/`isEditableTarget` copies became
transitional debt. Delete them and call the engine directly (`handleKeydown(e)`)
instead of keeping duplicate guard layers as backup; duplicate layers can drift
on Shift-only, `SELECT`, or contenteditable semantics.

# Related concepts

- [Key dispatch engines own consumed-event and editable-field guards](/lessons/keybinding-dispatch-guards-in-engine.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
