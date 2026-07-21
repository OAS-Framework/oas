---
type: Concept
title: Session-tail error surfacing for oas-web chat and roster
description: oas-web classifies the tail of pi and claude session JSONL files into ok/error/unknown sessionTail state so the chat pane can stop dead-turn spinners with an error banner and the roster can mark errored agents.
tags: [oas-web, sessionTail, session-errors, control-pane, parseTranscript]
timestamp: 2026-07-21
---

# Session-tail classification

`bin/oas-web.mjs` exposes `classifySessionTail(lines, kind)` for the
control-pane session-error contract:

- **pi**: inspect the tail for the last `type: "message"` entry. If that
  message has `stopReason === "error"`, classify as `state: "error"` and
  expose a trimmed `errorMessage` capped at 500 characters. If any later
  message exists, the session has recovered and classifies as `state: "ok"`.
  With no messages, classify as `state: "unknown"`.
- **claude**: a trailing entry with `error` or `isApiErrorMessage` classifies
  as an error.

Tail reads are intentionally cheap: read the last 64KB with `openSync` /
`readSync`, then drop the first line when the read starts in the middle of a
file so a truncated JSON line is not parsed.

# Shared-model fallback pattern

During the split between local server helpers and the shared control-pane
model, prefer exported shared helpers when present and keep a local fallback
for older checkouts:

```js
const sessionFileFor = typeof model.sessionFileFor === "function"
  ? model.sessionFileFor
  : localSessionFileFor;
```

Use the same pattern for `sessionTailState`. `collectControlPane` should prefer
an existing model-provided tail (`i.sessionTail || safeTail(i)`) so the local
fallback removes itself naturally once `lib/control-pane/model.mjs` exports the
shared implementation.

# Import-safe server module

`node:test` imports the server module directly, so top-level side effects must
be guarded: wrap `process.exit` usage and `server.listen` behind
`IS_MAIN = resolve(process.argv[1]) === fileURLToPath(import.meta.url)`.

# UI rendering contract

`/api/chat` includes `sessionTail` in its payload. In `ui/panel.html`,
`renderChat` uses `sessionTail.state` and `sessionTail.errorMessage` to show a
warning rail (`⚠ agent errored after your message`) and suppress the busy
indicator; otherwise a dead turn spins forever. The roster also renders a
`chip err` marker with the error text in `title=`, so `escapeHtml` must escape
quotes as `&quot;` in addition to normal text HTML escapes.

Include the session-tail state and error message in the chat render signature
(`lastChatSig`). Without those fields, transitions into or out of an error
state do not repaint the banner.

Related concepts: [transcript data sources](transcript-data-sources.md) and
[optimistic sends and indicators](optimistic-sends-and-indicators.md).
