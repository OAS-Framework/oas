---
type: Concept
title: Session-tail error surfacing for oas-web chat and roster
description: oas-web consumes the shared control-pane session-tail classification (ok/error/unknown) so the chat pane can stop dead-turn spinners with an error banner and the roster can mark errored agents.
tags: [oas-web, sessionTail, session-errors, control-pane, parseTranscript]
timestamp: 2026-07-21
---

# Session-tail classification lives in the shared model

`lib/control-pane/model.mjs` is the sole owner of session-tail logic:
`sessionFileFor(instance)`, `classifySessionTail(lines, kind)`, and
`sessionTailState(instance)`. oas-web imports `sessionFileFor` and
`sessionTailState` from it (`const { sessionFileFor, sessionTailState } =
model;`) — do not reintroduce local copies or fallbacks in
`bin/oas-web.mjs`; that duplication was deliberately deleted. Classification
tests live with the model in `test/control-pane-model.test.mjs`; oas-web's
tests cover only its own transcript parsing.

Classification semantics (for consumers):

- **pi**: the last `type: "message"` entry decides. `stopReason === "error"`
  ⇒ `state: "error"` with a trimmed `errorMessage` capped at 500 characters;
  any later message means the session recovered (`"ok"`); no messages ⇒
  `"unknown"`.
- **claude**: a trailing entry with `error` or `isApiErrorMessage` classifies
  as an error.

Tail reads are cheap: the model reads the last 64KB, but the first line is
only possibly truncated when the tail read actually began mid-file. Do not
drop the first line unconditionally; doing so can misclassify a short complete
log whose first message is the error as `unknown`. A pi error-stopped
assistant entry has empty content, so `parseTranscript` yields no turn for it
— the transcript alone can never show the failure; the error banner must come
from `sessionTail`.

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
