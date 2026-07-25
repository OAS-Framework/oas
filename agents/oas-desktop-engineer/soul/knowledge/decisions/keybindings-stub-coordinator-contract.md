---
type: Decision
title: Keybindings wiring used a transitional stub engine with a frozen coordinator contract
description: The keybindings-wiring branch initially shipped renderer/keybindings.mjs as a transitional stub that preserved the coordinator-facing action, context, chord, and dispatch surface until keybindings-core replaced it wholesale.
tags: [desktop, keybindings, coordination]
timestamp: 2026-07-25
---

# Decision

When keybindings wiring started, the `keybindings-core` sibling branch had not
landed on `feature/keybindings`. The wiring branch therefore shipped a transitional
`renderer/keybindings.mjs` stub with the frozen exported coordinator surface:

- `registerAction` returns a dispose callback;
- `setActiveContexts`;
- `getBinding`;
- `setBinding`;
- `onKeymapChange`;
- `formatChord`;
- `parseChord`;
- `matchesChord`;
- `handleKeydown`.

The `keybindings-core` engine later replaced the stub wholesale while preserving
this coordinator contract; integration details live in [the real-engine lesson](/lessons/real-keybindings-engine-integration.md).
`test/keybindings.test.mjs` pins the contract.

# Stub dispatch and lifecycle rules

- Terminal safety generalizes the earlier palette-shortcut guard: inside xterm,
  only `metaKey` chords fire; unmodified keys never fire in editable fields; on
  macOS, `Mod` accepts a Ctrl fallback outside terminals only.
- The transitional stub's `handleKeydown` skipped events where
  `e.defaultPrevented` was already true, so a view-local keydown handler such as
  hierarchy canvas `onKey` took precedence over registered chords for the same
  keys and avoided double dispatch. The real engine does not skip those events;
  the shell listener guards `if (!e.defaultPrevented)` before calling it.
- Views register stage-context actions during mount and dispose them during
  unmount, matching the desktop view lifecycle contract.

# Related concepts

- [View contract extension — mount() may return a per-mount disposer](/decisions/view-mount-disposer-contract.md)
