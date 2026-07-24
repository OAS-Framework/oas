---
type: Lesson
title: Multi-line sends require tmux bracketed paste, not send-keys
description: Any path that delivers text containing newlines into an agent pane must use load-buffer plus paste-buffer -p; raw send-keys/newline delivery submits each line separately or can execute pasted lines one by one.
tags: [desktop-backend, tmux, send-keys, bracketed-paste, gotcha]
timestamp: 2026-07-22
---

# The problem

A literal newline delivered through tmux key sending is an Enter keypress.
When a web input path sends text containing `\n` with `send-keys`, pi/claude
submit each line as a separate message. The original bug surfaced in the old
multi-line composer, but the lesson still applies after the composer was
removed: browser paste into the terminal-focused panel must not become raw
per-line carriage returns a shell could execute one by one.

# The fix

For any whole-text paste/multi-line path:

1. Normalize `\r\n?` to `\n`.
2. Load the complete text into a tmux buffer with `load-buffer` from stdin.
3. Deliver it to the target pane with `paste-buffer -p` so tmux wraps it as a
   bracketed paste.
4. Delete the temporary buffer afterward.

Regular keydown Enter can still be a raw `\r` key byte. Paste events and other
whole-text payloads must use bracketed paste.

# Current panel shape

The old `sendText` / `/api/send` composer path is gone. The active path is
`POST /api/keys`: ordinary keydown bytes use `send-keys -H`, while paste
payloads use `load-buffer` + `paste-buffer -p`. Keep that separation if the
input layer is refactored.

# Related concepts

- [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md)
- [One input surface — the terminal's own input line](/decisions/terminal-input-unification.md)
