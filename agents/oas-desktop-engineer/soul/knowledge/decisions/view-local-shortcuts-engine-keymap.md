---
type: Decision
title: View-local shortcuts resolve chords through the engine keymap
description: View-scoped single-key shortcuts stay DOM-local but resolve through the keybinding engine so editor rebinds override defaults while editable-field safety remains view-owned.
tags: [desktop, keybindings, views]
timestamp: 2026-07-25
---

# Decision

View-local shortcuts that are meant to be rebindable must resolve through the
keybinding engine instead of matching hard-coded `e.key` values in the view
handler. Hard-coded keys keep firing after an editor rebind and can shadow
another action's new binding.

# Pattern

Views declare actions in a local table such as `viewActions = [{ id, chord, run
}]`, where `chord` is the view's default. They register those actions unbound in
the engine so the shortcut editor can see them, then the view keydown handler
calls `resolveViewKey(e, viewActions)` from `renderer/view-keys.mjs`.

`resolveViewKey` checks engine bindings first (`getBinding`), so explicit user
bindings win. Defaults apply only to actions that the engine reports unbound.
Dispatch remains DOM-local to the focused canvas, grid, or other view surface,
which preserves the editable-field guard that the global engine cannot provide
for unmodified single keys.

Structural keys such as Enter, Escape, and arrows stay hard-coded when they are
focus semantics rather than shortcuts.

# Related concepts

- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
- [Keybindings wiring used a transitional stub engine with a frozen coordinator contract](/decisions/keybindings-stub-coordinator-contract.md)
