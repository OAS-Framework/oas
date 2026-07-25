---
type: Lesson
title: Real keybindings engine integration keeps defaults engine-owned
description: When keybindings-core replaced the wiring stub, wiring had to adopt DEFAULT_KEYMAP action ids, delete transitional shell guard layers once matchEvent owned them, drop view-local default backups once DEFAULT_KEYMAP owned them, and keep the action-id terminal allowlist.
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
  values or keep view-local chord fallback fields as a second source of
  defaults once the engine can represent the default.
- View-local actions such as `hier.*` and `spawn.*` were transitional when
  engine default metadata was missing: register them editor-visible and resolve
  DOM-local events only until `DEFAULT_KEYMAP`/default metadata can own the
  default. Once it can, delete the local chord fields instead of retaining backup
  defaults.
- After the core addendum, `matchEvent` skips `defaultPrevented` events and
  rejects unmodified chords from editable targets. The shell listener should call
  bare `handleKeydown(e)`; do not keep `if (!e.defaultPrevented)` or
  `allowsEngineDispatch(e)` as a second guard layer.
- The earlier shell-side `allowsEngineDispatch`/`isEditableTarget` pair was only
  temporary; keeping it as fallback is worse than one canonical engine policy
  because Shift-only and editable-element semantics can drift.
- Terminal safety follows the action-id allowlist, so Ctrl+K opens the palette
  inside xterm on Linux/Windows instead of passing through to the terminal.

# Related concepts

- [Keybindings wiring used a transitional stub engine with a frozen coordinator contract](/decisions/keybindings-stub-coordinator-contract.md)
- [View-local shortcuts resolve chords through the engine keymap](/decisions/view-local-shortcuts-engine-keymap.md)
- [Key dispatch engines own consumed-event and editable-field guards](/lessons/keybinding-dispatch-guards-in-engine.md)
- [Window-level dispatch guards were transitional shell responsibilities](/lessons/window-engine-dispatch-editable-guard.md)
- [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md)
