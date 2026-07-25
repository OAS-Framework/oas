---
type: Lesson
title: Dynamic action registrations carry their own default chords
description: View-local actions that register at mount should supply defaultChord in the registration so getBinding can resolve overrides, static defaults, registration defaults, and explicit-null unbinds from one place.
tags: [desktop, keybindings, registry, design]
timestamp: 2026-07-25
---

# Defaults travel with dynamic registrations

Static tables (`DEFAULT_KEYMAP`) suit shell-level actions that exist for the
app's lifetime. View-local actions such as `hier.*` and `spawn.*` register at
view mount and dispose at unmount, so putting their defaults in the static table
would list bindings for actions that may never register.

Dynamic registration defaults belong on `registerAction({ defaultChord })`, not
in a view-local fallback resolver. `getBinding` is the one resolution point:

1. a persisted override wins, including explicit `null` from Backspace-unbind;
2. otherwise a static `DEFAULT_KEYMAP[id]` chord wins;
3. otherwise the registration's `defaultChord` wins;
4. otherwise the action is unbound.

`registerAction` canonicalizes the registration default through
`parseChord`/`chordToString` at registration time; invalid input becomes `null`
and does not throw. Because `matchEvent`, `findConflict`, and editor rows all
read `getBinding`, dispatch, conflict checks, and display stay consistent.

# Gotchas

- `registerAction` and unregister must fire the keymap-change notifier: a mount
  that supplies a default chord changes effective bindings, and an open
  shortcuts editor must rerender.
- The editor's "is this the default?" check must compare against
  `DEFAULT_KEYMAP[id] ?? action.defaultChord`; otherwise untouched registration
  defaults show per-row reset buttons.
- Explicit-null persistence already round-trips through the sanitizer (`null` is
  a preserved override value), so unbind survives reload for
  registration-default actions with no extra storage work.

# Related concepts

- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
