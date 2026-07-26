---
type: Lesson
title: First-class view defaults need dispatch-ineligible contexts
description: A run()-level surface guard fires after matchEvent selects an action and preventDefault runs, so view actions should register under never-activated contexts and dispatch locally with resolveViewKey.
tags: [desktop, keybindings, views, dispatch]
timestamp: 2026-07-25
---

# Lesson

Registering view-local actions with engine-owned defaults (`defaultChord` or
`DEFAULT_KEYMAP`) makes the shortcut visible, rebindable, and conflict-checked.
If that action's context is active at the window-level `handleKeydown` listener,
though, the action becomes dispatch-eligible from any matching non-editable
target, not only from the view's own surface.

A registered `run()` surface guard is too late in the pipeline. By the time
`run()` declines an outside target, `matchEvent` has already selected the action
and `handleKeydown` has already called `preventDefault`. The outside key is
swallowed, and a no-op view match can shadow a colliding global action. In review
afd2114, rebinding a view action to Space could kill native button activation
outside the view.

Make view actions dispatch-ineligible for the window listener instead. Register
them under a context the shell never activates, such as `view:hierarchy` or
`view:spawn`, so `matchEvent` skips them before selection. Keep those contexts in
the shortcut editor's label/order maps so the actions remain editor-visible, and
let `findConflict` continue to check the registered actions. The actual in-view
side effect stays in the view's local key handler, which resolves chords with
`resolveViewKey`/`getBinding` and runs only for the view surface.

Regressions for this class should assert the event boundary, not just the final
side effect: an outside event produces a null match, `handleKeydown` returns
false, `preventDefault` is not called, a colliding global fallback can run, and
in-surface local dispatch still works.

# Fallback gotcha

If a legacy view resolver remains during migration, gate its fallback chord on
"the engine does not know this action id," not on "the effective binding is
`null`." An effective `null` can be the user's explicit Backspace-unbind, and a
fallback keyed to `null` resurrects the default.

# Related concepts

- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
- [Key dispatch engines own consumed-event and editable-field guards](/lessons/keybinding-dispatch-guards-in-engine.md)
- [View-default suppression must use context-aware conflict checks](/lessons/view-default-suppression-context-collision.md)
