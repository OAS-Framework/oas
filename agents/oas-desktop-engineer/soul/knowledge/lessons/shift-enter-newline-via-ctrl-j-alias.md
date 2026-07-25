---
type: Lesson
title: Shift+Enter through xterm/tmux must be translated to pi's Ctrl+J newline alias
description: xterm.js emits a plain \r for Enter regardless of Shift, and attachCustomKeyEventHandler runs for keydown/keypress/keyup; translate Shift+Enter to raw \n only on keydown and suppress the whole chord so keypress cannot leak a submit \r.
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
through tmux. The desktop terminal therefore translates Shift+Enter locally with
`term.attachCustomKeyEventHandler`: classify the Shift+Enter chord with no other
modifiers for every event type, write `"\n"` to the pty only on `keydown`, and
return `false` for the whole chord so xterm's default `\r` path never runs.

The handler is invoked once each for `keydown`, `keypress`, and `keyup` during a
single physical press. Returning `false` only for `keydown` still leaves xterm's
`_keyPress` path alive; when that path sees `charCode 13`, it emits its own `\r`
through `coreService.triggerDataEvent`. The result is `\n` immediately followed
by `\r`: the newline appears and the message submits anyway.

The classifier lives as `shiftEnterByte(ev)` in
`packages/desktop/renderer/terminal-tab.mjs`, and the handler is installed inside
`onReady` per the terminal lifecycle contract. Tests should cover both the pure classifier and the wired handler: suppression
for all event types, pty write only on keydown, and no write after the terminal
closes. JSDOM-only tests cannot prove this leak because the extra submit comes
from xterm's internal keypress path; verify end-to-end by attaching the tab to a
tmux window running a raw-stdin byte printer such as `node -e` in raw mode or
`cat -v`.

# Related concepts

- [Desktop terminal is a direct tmux attach via node-pty](/decisions/desktop-terminal-direct-attach.md)
- [Multi-line sends require tmux bracketed paste, not send-keys](/lessons/multiline-send-bracketed-paste.md) covers whole-text paste/multi-line payloads; Shift+Enter remains an interactive keydown alias.
