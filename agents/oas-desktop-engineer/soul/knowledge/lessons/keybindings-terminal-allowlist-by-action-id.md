---
type: Lesson
title: Keybinding engine terminal allowlist is action-id based, not chord based
description: On Linux/Windows the keybinding engine allowlists action ids inside .xterm, but xterm consumes claimed chords before bubble-phase window listeners; terminal tabs must intercept them with attachCustomKeyEventHandler before the pty write.
tags: [desktop, keybindings, terminal-safety, xterm, design]
timestamp: 2026-07-25
---

# Allowlist by action id, not chord

The keybindings contract requires that inside `.xterm` on Linux/Windows only
"the palette chord and tab next/prev/close" may fire. Implementing the
allowlist as concrete chords would break silently when a user rebinds those
actions: the rebound chord would stop working inside the terminal, and the old
chord's semantics would be ambiguous. `keybindings.mjs` therefore allowlists
**action ids** (`TERMINAL_ALLOWLIST = ["app.palette", "tabs.next", "tabs.prev",
"tabs.close"]`) and checks membership after chord matching, so the policy
follows the binding wherever the user moves it.

# Deliberate divergence from isPaletteShortcut

Legacy `palette.mjs isPaletteShortcut` let Ctrl+K pass through to the attached
program inside xterm on Linux/Windows. The keybindings task spec explicitly
allowlists the palette chord inside the terminal, so the engine diverges there;
the parity test in `test/keybindings.test.mjs` documents the divergence
explicitly instead of hiding it in a loop.

# Xterm interception must be pre-pty, not window-level

The action-id allowlist cannot be enforced only from the shell's bubble-phase
window `keydown` listener. With terminal focus, xterm's textarea `keydown`
handler runs in capture phase, writes the control byte to the pty, and then
calls `preventDefault()` plus `stopPropagation()`; the window listener never sees
claimed chords such as Ctrl+K. Terminal tabs must use
`term.attachCustomKeyEventHandler`, which is the pre-pty hook.

Keep terminal key decisions pure and ordered. In `terminal-tab.mjs`,
`terminalKeyDecision(ev, interceptKey)` handles Shift+Enter newline translation
first because that path intentionally writes a byte, then asks the shell
interception hook whether the engine claims the chord, otherwise passing through.
When the shell hook claims an event, return `false` for every phase (`keydown`,
`keypress`, and `keyup`) and dispatch `handleKeydown` only once on `keydown`;
returning true for `keypress` or `keyup` can leak bytes just like the
Shift+Enter `\r` leak. The shell-side hook should match with
`insideTerminal: true` and then call `handleKeydown` for dispatch.

# Mac policy detail

On macOS inside `.xterm`, a chord only fires when its `Mod` resolved to meta AND
the event has no `ctrlKey`. An explicit `Ctrl+X` binding never fires inside the
terminal because Ctrl belongs to the pty (tmux prefix, readline, signals), which
mirrors `app-menu.mjs`'s role-menu rationale.

# Related concepts

- [Raw key passthrough and the loopback Host/Origin guards](/architecture/raw-key-passthrough-and-host-guard.md)
- [Shift+Enter through xterm/tmux must be translated to pi's Ctrl+J newline alias](/lessons/shift-enter-newline-via-ctrl-j-alias.md)
- [Key dispatch engines own consumed-event and editable-field guards](/lessons/keybinding-dispatch-guards-in-engine.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
