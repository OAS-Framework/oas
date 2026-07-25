---
type: Lesson
title: Shift+Enter through xterm/tmux must be translated to pi's Ctrl+J newline alias
description: xterm.js emits a plain \r for Enter regardless of Shift, so the modifier is lost before tmux/pi; the desktop terminal translates Shift+Enter to a raw \n (pi's documented Ctrl+J newline alias) via attachCustomKeyEventHandler and suppresses the default \r.
tags: [desktop-terminal, xterm, keybindings, pi]
timestamp: 2026-07-25
---

# Shift+Enter through xterm/tmux must be translated to pi's Ctrl+J newline alias

Shift+Enter did not insert a newline in the desktop chat/terminal because
xterm.js encodes Enter as `\r` with or without Shift. The Shift modifier never
reaches tmux or the agent runtime. Real terminals solve this class of problem
with the Kitty keyboard protocol / `modifyOtherKeys`, but xterm.js does not emit
that protocol for the app's key path.

pi documents `Ctrl+J` — a raw `\n` linefeed — as a default alias for
`tui.input.newLine`, precisely for terminals that cannot deliver Shift+Enter
through tmux. The desktop terminal therefore translates Shift+Enter locally:
`term.attachCustomKeyEventHandler` classifies a Shift+Enter keydown with no other
modifiers, writes `"\n"` to the pty, and returns `false` to suppress xterm's
default `\r`. Without suppressing the default, the message sends and a newline is
inserted.

The classifier lives as `shiftEnterByte(ev)` in
`packages/desktop/renderer/terminal-tab.mjs`, and the handler is installed inside
`onReady` per the terminal lifecycle contract. Tests cover both the pure
classifier and the wired handler: suppression, pty write, and no write after the
terminal closes.

# Related concepts

- [Desktop terminal is a direct tmux attach via node-pty](/decisions/desktop-terminal-direct-attach.md)
- [Multi-line sends require tmux bracketed paste, not send-keys](/lessons/multiline-send-bracketed-paste.md) covers whole-text paste/multi-line payloads; Shift+Enter remains an interactive keydown alias.
