---
type: Lesson
title: Real keybindings engine integration keeps defaults engine-owned
description: When keybindings-core replaced the wiring stub, wiring had to adopt DEFAULT_KEYMAP action ids, leave view-local actions unbound, guard defaultPrevented at the shell listener, and accept the action-id terminal allowlist where Ctrl+K opens the palette in xterm.
tags: [desktop, keybindings, merge, integration]
timestamp: 2026-07-25
---

# Integration lessons

When `keybindings-core` replaced the wiring branch's stub, the core
`keybindings.mjs` and `keybindings.test.mjs` won wholesale. The wiring side then
had to adapt to the real engine instead of preserving stub-only registration
shape.

- Wiring action ids must match the engine's `DEFAULT_KEYMAP` canon:
  `app.themeToggle`, `sidebar.focusFilter`, `terminal.font*`, and
  `app.shortcuts = Mod+,`.
- Defaults live only in `DEFAULT_KEYMAP`; do not pass per-registration `chord:`
  values as a second source of defaults.
- View-local actions such as `hier.*` and `spawn.*` register unbound but
  editor-visible. Keep their single-key dispatch view-scoped, because the engine
  has no editable-field guard that would make unmodified single keys safe as
  global defaults.
- The real engine's `handleKeydown` does not skip `defaultPrevented` events.
  The shell listener must guard `if (!e.defaultPrevented)` before calling it when
  a view-local handler has already claimed a key event.
- User-recorded bare-key bindings can still match through the shell's window
  listener from editable targets, so call `allowsEngineDispatch(e)` at the shell
  dispatch site as described in [the editable-target guard lesson](/lessons/window-engine-dispatch-editable-guard.md).
- Terminal safety follows the action-id allowlist, so Ctrl+K opens the palette
  inside xterm on Linux/Windows instead of passing through to the terminal.

# Related concepts

- [Keybindings wiring used a transitional stub engine with a frozen coordinator contract](/decisions/keybindings-stub-coordinator-contract.md)
- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
- [Window-level engine dispatch needs an editable-target guard](/lessons/window-engine-dispatch-editable-guard.md)
- [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md)
