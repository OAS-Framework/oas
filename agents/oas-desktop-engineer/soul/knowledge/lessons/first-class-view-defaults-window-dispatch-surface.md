---
type: Lesson
title: First-class view defaults widen window-level dispatch
description: Once a view-local action has an engine-owned default, window dispatch can run it from any non-editable target in the active context, so the registered run() must verify the event started inside the view surface.
tags: [desktop, keybindings, views, dispatch]
timestamp: 2026-07-25
---

# Lesson

Registering view-local actions with engine-owned defaults (`defaultChord` or
`DEFAULT_KEYMAP`) makes the shortcut visible, rebindable, and conflict-checked,
but it also makes the action dispatch-eligible for the window-level
`handleKeydown` path whenever that action's context is active.

That dispatch surface is wider than the view surface. A focused non-editable
control outside the view body, such as a nav-rail button, can still originate a
matching keydown; pressing `f` from a focused rail button ran `hier.fit` in review
0e63834. Editor visibility and dispatch eligibility are coupled in the engine.

Guard the registered `run()` at the registration site. For hierarchy actions,
check that `s.canvas.contains(e.target)`; for spawn actions, check the view root.
If the event did not originate inside the promised surface, return without
running the action.

Do not move this guard into `matchEvent`. The binding still needs to participate
in editor display, rebinding, and conflict detection; only the side effect of the
registered action is surface-scoped.

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
