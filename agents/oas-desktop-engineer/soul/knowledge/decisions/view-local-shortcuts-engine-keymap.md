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

When a registered view action is also visible to the window-level engine listener
for its active context, do not rely on the local handler to define the execution
surface. The registered `run()` must verify that the event originated inside the
view's promised surface; see [the window-dispatch surface lesson](/lessons/first-class-view-defaults-window-dispatch-surface.md).

Do not keep a parallel view fallback resolver that treats `null` as both
"no default" and "explicit unbind". Registration defaults are part of the action
registration contract, as captured in [the dynamic registration default lesson](/lessons/dynamic-action-registration-default-chords.md).

When a view resolver yields a local default to explicit bindings elsewhere, its
anti-shadowing scan must use the engine's same-context/global collision rule;
see [the context-aware suppression lesson](/lessons/view-default-suppression-context-collision.md).

Structural keys such as Enter, Escape, and arrows stay hard-coded when they are
focus semantics rather than shortcuts.

# Related concepts

- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [First-class view defaults widen window-level dispatch](/lessons/first-class-view-defaults-window-dispatch-surface.md)
- [View-default suppression must use context-aware conflict checks](/lessons/view-default-suppression-context-collision.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
- [Keybindings wiring used a transitional stub engine with a frozen coordinator contract](/decisions/keybindings-stub-coordinator-contract.md)
