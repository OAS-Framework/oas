---
type: Lesson
title: Dialog chord recorders need a hoisted teardown reachable from close and rerender
description: A click-to-record capture listener installed on document outlives an overlay dialog unless a single hoisted stopRecording teardown is invoked from close(), every rerender, reset-all, and normal completion; localStorage-loaded keymap overrides must be sanitized to null-or-parseable-chord before any consumer formats them.
tags: [desktop, keybindings, dialog, teardown, validation, review]
timestamp: 2026-07-25
---

# The bug pattern

The shortcuts editor's recorder added a `document`-level capture keydown
listener inside `startRecording` with a locally scoped `stop()`. `close()` and
`render()` cleared the `recording` flag but could not reach `stop()`, so after
"click chord → close dialog → press ⌘X" the dead dialog still
`preventDefault`-ed the event and persisted the binding.

# Fix pattern

1. **Hoist teardown**: one module-level `stopRecording` holder; `endRecording()`
   is called from `close()`, every `render()`, reset-all, Esc/Backspace, and
   normal completion. Any capture listener on `document` must have a teardown
   reachable from every path that invalidates its UI anchor.
2. **Sanitize persisted overrides at load**: `readOverrides()` keeps only
   `null` (explicit unbind) or strings that round-trip through
   `parseChord` → `chordToString`; a stored `{"app.palette":42}` must not make
   the editor throw. Anything read from localStorage is untrusted input for
   every downstream formatter.
3. **Enforce aria-modal, do not only declare it**: add the Tab/Shift+Tab focus
   wrap whenever a dialog claims `aria-modal="true"`, using the same pattern as
   workspace-switcher's `onDialogKey`.

# Regression shape

- For the closed-dialog swallow bug, dispatch a `KeyboardEvent` on `document`
  after `close()` and assert `defaultPrevented === false` and the binding is
  unchanged.
- For load-time override sanitization, pre-poison localStorage and import a
  fresh module with a cache-busting query such as
  `import("../renderer/keybindings.mjs?fresh=" + Math.random())`.

# Related concepts

- [Modal innerHTML rerenders must restore focus by stable key](/lessons/modal-rerender-focus-restoration.md)
- [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
