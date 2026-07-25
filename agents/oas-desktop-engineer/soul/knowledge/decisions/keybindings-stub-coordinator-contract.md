---
type: Decision
title: Keybindings wiring used a transitional stub engine with a frozen coordinator contract
description: The keybindings-wiring branch initially shipped renderer/keybindings.mjs as a transitional stub that preserved the coordinator-facing action, context, chord, and dispatch surface until keybindings-core replaced it wholesale; the final engine internalizes the dispatch guards the stub pioneered.
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
- `matchesChord` (stub-only event/chord matcher — the real engine replaced it
  with `matchEvent`, which matches an event against ALL registered actions);
- `handleKeydown`.

The `keybindings-core` engine later replaced the stub wholesale while preserving
this coordinator contract; integration details live in [the real-engine lesson](/lessons/real-keybindings-engine-integration.md).
`test/keybindings.test.mjs` pins the contract.

# Stub dispatch rules and their final-engine fate (historical)

- Terminal safety in the STUB generalized the earlier palette-shortcut guard:
  inside xterm, only `metaKey` chords fired. The FINAL engine replaced this
  with an action-id allowlist on Linux/Windows (palette, tab next/prev/close
  may fire inside xterm; Ctrl+K deliberately opens the palette there) — see
  [the allowlist lesson](/lessons/keybindings-terminal-allowlist-by-action-id.md).
- The stub's `handleKeydown` skipped events where `e.defaultPrevented` was
  already true and refused unmodified chords on editable fields. The FINAL
  engine internalized BOTH guards in `matchEvent`/`handleKeydown` (core
  contract addendum), so the shell listener is a bare `handleKeydown(e)`
  delegation with no wrapper guard — see
  [the engine-owned guards lesson](/lessons/keybinding-dispatch-guards-in-engine.md).
  Transitional shell-side copies of these guards were deleted when the engine
  took ownership.
- Views register stage-context actions during mount and dispose them during
  unmount, matching the desktop view lifecycle contract — unchanged in the
  final design (defaults ride `registerAction({ defaultChord })`).

# Related concepts

- [View contract extension — mount() may return a per-mount disposer](/decisions/view-mount-disposer-contract.md)
