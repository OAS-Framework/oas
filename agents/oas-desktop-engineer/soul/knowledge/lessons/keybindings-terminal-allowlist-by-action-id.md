---
type: Lesson
title: Keybinding engine terminal allowlist is action-id based, not chord based
description: On Linux/Windows the keybinding engine allowlists action ids (palette, tab next/prev/close) inside .xterm rather than concrete chords, so user rebinds keep the policy intact; note the deliberate divergence from legacy isPaletteShortcut which passed Ctrl+K through to the terminal.
tags: [desktop, keybindings, terminal-safety, design]
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

# Mac policy detail

On macOS inside `.xterm`, a chord only fires when its `Mod` resolved to meta AND
the event has no `ctrlKey`. An explicit `Ctrl+X` binding never fires inside the
terminal because Ctrl belongs to the pty (tmux prefix, readline, signals), which
mirrors `app-menu.mjs`'s role-menu rationale.

# Related concepts

- [Raw key passthrough and the loopback Host/Origin guards](/architecture/raw-key-passthrough-and-host-guard.md)
- [Shift+Enter through xterm/tmux must be translated to pi's Ctrl+J newline alias](/lessons/shift-enter-newline-via-ctrl-j-alias.md)
