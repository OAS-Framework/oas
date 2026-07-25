---
type: Decision
title: View-local shortcuts resolve chords through the engine keymap
description: View-scoped single-key shortcuts stay DOM-local but resolve through keybinding engine registrations so editor rebinds and registration-supplied defaults share one source of truth while editable-field safety remains view-owned.
tags: [desktop, keybindings, views]
timestamp: 2026-07-25
---

# Decision

View-local shortcuts that are meant to be rebindable must resolve through the
keybinding engine instead of matching hard-coded `e.key` values in the view
handler. Hard-coded keys keep firing after an editor rebind and can shadow
another action's new binding.

# Pattern

Views declare actions in a local table such as `viewActions = [{ id,
defaultChord, run }]`, where `defaultChord` is the view's default. At mount they
register those actions with `registerAction({ defaultChord })` so the shortcut
editor can see them and the engine owns default resolution.

View keydown handlers still dispatch DOM-locally to the focused canvas, grid, or
other view surface, preserving the editable-field guard that the global engine
cannot provide for unmodified single keys. But they resolve the active chord
through `getBinding`: explicit user bindings win, explicit persisted `null`
means unbound, static `DEFAULT_KEYMAP` entries cover app-lifetime actions, and
registration defaults cover mount-time view-local actions.

Do not keep a parallel view fallback resolver that treats `null` as both
"no default" and "explicit unbind". Registration defaults are part of the action
registration contract, as captured in [the dynamic registration default lesson](/lessons/dynamic-action-registration-default-chords.md).
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

Do not patch the engine from a wiring branch; route this as an engine contract
change.

Structural keys such as Enter, Escape, and arrows stay hard-coded when they are
focus semantics rather than shortcuts.

# Related concepts

- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
- [Keybindings wiring used a transitional stub engine with a frozen coordinator contract](/decisions/keybindings-stub-coordinator-contract.md)
