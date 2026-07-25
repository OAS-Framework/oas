---
type: Decision
title: View-local shortcuts need engine-owned default metadata
description: View-scoped shortcuts may resolve events locally, but their defaults belong in engine-owned metadata; once DEFAULT_KEYMAP owns a view default, remove local chord fallbacks so editor display and dispatch cannot drift.
tags: [desktop, keybindings, views]
timestamp: 2026-07-25
---

# Decision

View-local shortcuts that are meant to be rebindable should keep DOM-local
dispatch for focused view surfaces, but their default chords must be represented
as engine-owned action metadata. Keeping defaults only in view-local tables
cannot make the shortcut editor honest or let explicit unbinds disable a
default, because `getBinding()` returns `null` for both "no default" and
"explicitly unbound".

# Wiring-side pattern

Views declare actions in a local table such as `viewActions = [{ id, chord, run
}]`, where `chord` is the view's default. They register those actions unbound in
the engine so the shortcut editor can see them, then the view keydown handler
calls `resolveViewKey(e, viewActions)` from `renderer/view-keys.mjs`.

`resolveViewKey` can handle the shadowing half wiring-side: it consults the
engine action list and yields when the event chord is explicitly bound to any
other action. Explicit user bindings therefore win, and hard-coded local `e.key`
comparisons do not shadow another action's new binding.

Defaults that live only in `view-keys.mjs` are interim. When `getBinding()`
reports `null`, the view cannot tell "no default" from "user pressed Backspace
to unbind this default", so a local fallback default keeps firing and the editor
shows the action as unbound while its key fires.

# Contract addendum

The engine needs a registration-time default metadata path such as
`registerAction({ ..., defaultChord })` that merges view defaults into the
effective keymap alongside `DEFAULT_KEYMAP` for shell actions. With view defaults
first-class, `getBinding`, editor display, rebind, and unbind flows all see the
same default state while dispatch remains DOM-local.

# Contract outcome

When the engine/default keymap can own a view's default chord, delete the view's
local `chord` field instead of keeping it as backup. Local fallback defaults
recreate the same mismatch: the editor and explicit-unbind flow read the engine
keymap, while the view handler may still fire an old hard-coded chord.

If the contract is still missing, do not patch the engine from a wiring branch;
route it as an engine contract change.

Structural keys such as Enter, Escape, and arrows stay hard-coded when they are
focus semantics rather than shortcuts.

# Related concepts

- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
- [Keybindings wiring used a transitional stub engine with a frozen coordinator contract](/decisions/keybindings-stub-coordinator-contract.md)
