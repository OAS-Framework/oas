---
type: Concept
title: Raw key passthrough and the POST host/origin guard
description: POST /api/keys sends browser keydown bytes into the pane via tmux send-keys -H, routes large payloads through load-buffer/paste-buffer, and rejects non-loopback POST Host/Origin values to prevent DNS-rebinding terminal injection.
tags: [oas-web, security, tmux, keys]
timestamp: 2026-07-22
---

# Key byte path

The terminal-faithful session view translates browser key events to bytes on the
client, batches them briefly, and posts those bytes to `/api/keys`:

- Enter becomes `\r`, Backspace becomes `\x7f`, arrow keys become CSI `A`–`D`,
  Ctrl-letter chords become control bytes, and Alt prefixes the byte sequence
  with ESC.
- Cmd shortcuts stay in the browser.
- Paste normalizes `\n` to `\r`.
- Batches are coalesced for about 12ms before POSTing.

The server writes the byte stream with `tmux send-keys -H <hex...>` so tmux
receives raw bytes rather than key names, and no shell interpretation is
involved. Payloads larger than 512 chars use `load-buffer` plus
`paste-buffer -p`; hundreds of synchronous `send-keys -H` executions would
block the single-threaded server.

The key queue is tagged with the instance selected when the user typed, so a
mid-flight instance switch does not leak queued bytes into the newly selected
pane.

# POST Host/Origin guard

A hostile web page can DNS-rebind to `127.0.0.1`; with a key-injection endpoint
that would mean arbitrary terminal byte injection. All POST endpoints require a
loopback `Host` and, when an `Origin` header is present, a loopback `Origin`.
Requests failing that guard return 403. GET endpoints are unchanged.

# Related concepts

- The hand-rolled renderer and screen mapping are captured in
  [Terminal-faithful session renderer](/decisions/hand-rolled-terminal-renderer.md).
- Multi-line composer sends use bracketed paste for a different path; see
  [Multi-line sends require tmux bracketed paste, not send-keys](/lessons/multiline-send-bracketed-paste.md).
