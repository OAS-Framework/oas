---
type: Decision
title: Keybindings wiring uses a transitional stub engine with a frozen coordinator contract
description: The keybindings-wiring branch ships renderer/keybindings.mjs as a transitional stub that preserves the coordinator-facing action, context, chord, and dispatch surface until keybindings-core replaces it.
tags: [desktop, keybindings, coordination]
timestamp: 2026-07-25
---

# Decision

When keybindings wiring started, the `keybindings-core` sibling branch had not
landed on `feature/keybindings`. The wiring branch therefore ships a transitional
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

The `keybindings-core` engine may replace the stub wholesale when it lands, but
it must preserve this coordinator contract or supersede it deliberately.
`test/keybindings.test.mjs` pins the contract.

# Dispatch and lifecycle rules

- Terminal safety generalizes the earlier palette-shortcut guard: inside xterm,
  only `metaKey` chords fire; unmodified keys never fire in editable fields; on
  macOS, `Mod` accepts a Ctrl fallback outside terminals only.
- `handleKeydown` skips events where `e.defaultPrevented` is already true, so a
  view-local keydown handler such as hierarchy canvas `onKey` takes precedence
  over registered chords for the same keys and avoids double dispatch.
- Views register stage-context actions during mount and dispose them during
  unmount, matching the desktop view lifecycle contract.

# Related concepts

- [View contract extension — mount() may return a per-mount disposer](/decisions/view-mount-disposer-contract.md)
