---
type: Concept
title: Raw key passthrough and the POST host/origin guard
description: POST /api/keys is the panel's sole text-input path, sending browser keydown bytes into the logically focused pane via tmux send-keys -H, routing large or pasted payloads through load-buffer/paste-buffer, forcing a short-tail repaint so echo is visible, and rejecting non-loopback POST Host/Origin values.
tags: [oas-web, security, tmux, keys]
timestamp: 2026-07-22
---

# Key byte path

The terminal-faithful session view translates browser key events to bytes on the
client, batches them briefly, and posts those bytes to `/api/keys`. This is the
panel's sole text-input path: there is no separate chat composer and no
`/api/send` endpoint.

Routing follows the panel's logical focused pane rather than DOM focus on a
terminal element. A window keydown/paste listener sends to `focusedPane()` when
`document.activeElement` is not a real editable control (`INPUT`, `TEXTAREA`,
`SELECT`, or `contentEditable`); any mousedown inside a pane claims logical
focus for that pane.

The client mapping is:

- Enter becomes `\r`, Backspace becomes `\x7f`, arrow keys become CSI `A`–`D`,
  Ctrl-letter chords become control bytes, and Alt prefixes the byte sequence
  with ESC.
- Cmd shortcuts stay in the browser; Cmd-B is the panel sidebar toggle, while
  Ctrl-B is delivered to the session as the tmux prefix.
- Pastes are sent with `{ paste: true }`; the server normalizes `\r\n?` to `\n`
  and delivers the whole text as one bracketed paste via `load-buffer` +
  `paste-buffer -p` — never as raw carriage returns a shell could execute
  line by line.
- Batches are coalesced for about 12ms before POSTing.

The server writes the byte stream with `tmux send-keys -H <hex...>` so tmux
receives raw bytes rather than key names, and no shell interpretation is
involved. Payloads larger than 512 chars use `load-buffer` plus
`paste-buffer -p`; hundreds of synchronous `send-keys -H` executions would
block the single-threaded server.

The key queue is tagged with the instance selected when the user typed, so a
mid-flight instance switch does not leak queued bytes into the newly selected
pane.

After each key flush, the UI treats typing as "show me the prompt": it sets a
short `snapUntil` window, forces a terminal refresh, and uses a small tail
capture so the prompt row and echo repaint quickly without fetching the full
scrollback on every keystroke. See
[Typing must force-repaint and pin the prompt row](/lessons/typing-echo-visibility.md).

# POST Host/Origin guard

A hostile web page can DNS-rebind to `127.0.0.1`; with a key-injection endpoint
that would mean arbitrary terminal byte injection. All POST endpoints require a
loopback `Host` and, when an `Origin` header is present, a loopback `Origin`.
Requests failing that guard return 403. GET endpoints are unchanged.

# Related concepts

- The hand-rolled renderer and screen mapping are captured in
  [Terminal-faithful session renderer](/decisions/hand-rolled-terminal-renderer.md).
- The one-input UX decision is captured in
  [One input surface — the terminal's own input line](/decisions/terminal-input-unification.md).
- DOM focus is too fragile for pane routing; see
  [Route panel keyboard by logical pane focus, not DOM focus](/lessons/logical-key-routing-not-dom-focus.md).
- Key delivery is not enough if the echo is hidden; see
  [Typing must force-repaint and pin the prompt row](/lessons/typing-echo-visibility.md).
- Multi-line text still needs bracketed paste rather than raw per-line sends; see
  [Multi-line sends require tmux bracketed paste, not send-keys](/lessons/multiline-send-bracketed-paste.md).
