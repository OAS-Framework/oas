---
type: Concept
title: Optimistic sends, thinking indicator, and the fast-poll window
description: A send appears instantly as a pending block via the pendingSends queue and is reconciled away once the transcript records it, while a 20-second fastPollUntil window tightens polling to 400ms and a bottom-of-pane indicator distinguishes "agent is thinking" from "agent is working".
tags: [oas-web, pendingSends, fastPollUntil, ux, polling]
timestamp: 2026-07-21
---

# Optimistic sends (`pendingSends` in panel.html)

A message typed in the composer takes seconds to appear in the runtime's
transcript file — without feedback a send "feels swallowed". So:

1. On send, the text is pushed onto `pendingSends` and rendered immediately
   as a pending block (dashed accent rail, slightly faded).
2. On each transcript render, any pending entry whose trimmed text now
   appears among the shown user turns is spliced out (reconciliation) —
   remaining ones still render as pending.
3. Switching instances clears `pendingSends` (part of the race-fix cache
   isolation — see [stale-response-race](../lessons/stale-response-race.md)).

# Fast-poll window

`fastPollUntil = Date.now() + 20000` is set on send; a 400ms interval calls
`refreshChat` while inside the window, on top of the normal 1.5s poll. This
makes the echo of your own message and the agent's first reaction feel live
without permanently tightening the poll.

# Busy indicator states

At the bottom of the transcript a spinner + blinking dots line renders when
the session is "busy", with two labels:

- **"agent is thinking"** — the last turn is a user turn or there are
  unreconciled `pendingSends` (your message landed, no response yet).
- **"agent is working"** — the last assistant turn has an unfinished tool
  call (`tools` with `result === null`).

An in-flight tool call's `●` marker pulses instead of sitting static. The
indicator disappears the moment the transcript settles. Also: transient
fetch errors keep the last good render instead of blanking the pane, and a
freshly selected instance shows a centered "Loading session…" spinner
instead of a blank pane.
