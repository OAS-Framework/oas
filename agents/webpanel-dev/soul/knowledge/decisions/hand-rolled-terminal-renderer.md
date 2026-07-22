---
type: Decision
title: Terminal-faithful session renderer — hand-rolled SGR parser, no xterm.js
description: The terminal-faithful session surface deliberately renders raw tmux ANSI capture with an in-panel SGR parser instead of xterm.js or another package, with server-reported geometry, cursor state, and history depth used to map capture lines to screen rows.
tags: [oas-web, terminal, ansi, design-decision]
timestamp: 2026-07-22
---

# Decision: no terminal package

The human explicitly rejected vendoring xterm.js: "can we not make our own
rather than using a package?" Keep the session view as a hand-rolled renderer
in `panel.html`, not a third-party terminal emulator package.

The renderer consumes the raw `tmux capture-pane -p -e -J` output directly. It
regex-tokenizes ANSI, handles SGR state, emits spans, and strips escape
sequences outside the supported display subset. The supported SGR surface
includes reset/style toggles, 16-color foreground/background classes,
256-color, truecolor, and reverse video. Base-16 colors use CSS classes so the
Solarized-light remap still works; 256-color and truecolor values render as
literal `rgb()` styles.

SGR state must carry across lines because tmux can emit color runs spanning
lines when `-J` joins wrapped output.

# Screen, scrollback, and cursor mapping

Do not derive the screen start from `lines.length - rows` alone. tmux trims
trailing blank lines from `capture-pane` output, which misplaces the cursor on a
non-full screen. The server reports:

- pane geometry,
- `history = min(history_size, requested lines)`,
- cursor x/y and visibility from `display-message '#{cursor_x} #{cursor_y} #{cursor_flag} #{pane_in_mode}'`.

The client uses `screenStart = min(history, lines.length)` to map capture lines
to screen rows deterministically. It draws a block cursor at `(cx, cy)`, padding
past end-of-line when needed. Hide the cursor while the pane is in copy-mode;
that cursor is not where typed input lands.

Each captured line is one grid row (`white-space: pre`, horizontal overflow
allowed). tmux already wrapped at pane width, so the client must not re-wrap.

# Test hook

The renderer logic is unit-testable by extracting the script block from
`panel.html` and evaluating it against DOM stubs. `node --check` plus a
sandboxed eval against a real capture caught real issues during the
terminal-fidelity implementation.

# Related concepts

- Raw key input for the same surface is captured in
  [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md).
- Color adaptation for SGR output is captured in
  [Color adaptation](/architecture/color-adaptation.md).
