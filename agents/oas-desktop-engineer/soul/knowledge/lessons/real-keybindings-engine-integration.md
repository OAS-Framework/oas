---
type: Lesson
title: Real keybindings engine integration keeps defaults engine-owned
description: When keybindings-core replaced the wiring stub, wiring had to adopt DEFAULT_KEYMAP action ids, keep view defaults in engine metadata, delete transitional shell guard layers once matchEvent owned them, and keep the action-id terminal allowlist.
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
- Shell-level app defaults live in `DEFAULT_KEYMAP`; dynamic view-local defaults
  belong on `registerAction({ defaultChord })`, not in a parallel view fallback
  resolver. Once an engine-owned source can represent a default, delete the
  view-local backup chord fields instead of keeping a second source of truth.
- View-local actions such as `hier.*` and `spawn.*` register with their
  `defaultChord` under dispatch-ineligible view contexts that the shell never
  activates. Keep editor labels/order metadata so they stay visible and
  conflict-checked, while single-key dispatch remains in the local view handler
  with DOM-local focus semantics.
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
- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [Key dispatch engines own consumed-event and editable-field guards](/lessons/keybinding-dispatch-guards-in-engine.md)
- [Window-level dispatch guards were transitional shell responsibilities](/lessons/window-engine-dispatch-editable-guard.md)
- [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md)
