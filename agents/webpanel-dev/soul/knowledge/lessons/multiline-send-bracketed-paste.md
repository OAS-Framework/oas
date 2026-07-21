---
type: Lesson
title: Multi-line sends require tmux bracketed paste, not send-keys
description: Sending text containing newlines via tmux send-keys makes the TUI submit each line as a separate message, so multi-line sends must go through load-buffer plus paste-buffer -p (bracketed paste) followed by a single Enter.
tags: [oas-web, tmux, send-keys, bracketed-paste, gotcha]
timestamp: 2026-07-21
---

# The problem

The composer sends into the agent's terminal with `tmux send-keys`. A literal
`\n` inside `send-keys -l` text is delivered as Enter keypresses — pi/claude
submit **each line as its own message**. This surfaced when the composer
became a multi-line textarea (Shift+Enter = newline).

# The fix (`sendText` in bin/oas-web.mjs)

```js
if (text.includes("\n")) {
  execFileSync("tmux", ["load-buffer", "-b", "oasweb", "-"], { input: text });
  execFileSync("tmux", ["paste-buffer", "-p", "-d", "-b", "oasweb", "-t", target]);
} else {
  execFileSync("tmux", ["send-keys", "-t", target, "-l", text]); // -l = literal
}
execFileSync("tmux", ["send-keys", "-t", target, "Enter"]);
```

- `load-buffer -b oasweb -` reads the text from stdin into a named tmux buffer.
- `paste-buffer -p` pastes it in **bracketed-paste mode**, so the TUI treats
  it as one pasted block (exactly like pasting into the terminal yourself);
  `-d` deletes the buffer after.
- A single trailing `Enter` submits the whole block.

Single-line stays on `send-keys -l` (literal, no key-name interpretation),
then Enter as a separate key. Keep both paths — bracketed paste for a
one-liner is unnecessary, and `-l` matters (without it "Enter" in the text
would be interpreted as a key name).
