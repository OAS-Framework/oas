---
type: Decision
title: Chat view design landed on a pi-style transcript, not chat bubbles
description: The chat view went through four designs in one day — messenger bubbles, then a Codex-CLI-like transcript, then the Codex-app "Worked" layout, and finally settled on a pi-style transcript on the terminal surface — because the user wanted the terminal feel, not a messaging app.
tags: [oas-web, design, chat-view, pi-style, ux]
timestamp: 2026-07-21
---

# The evolution (all within oas.web 0.4.0 → 0.5.x)

1. **Messenger bubbles** — right-aligned accent bubbles for the user, bordered
   cards for the agent, collapsible tool cards. Classic chat app. Rejected:
   too far from the terminal.
2. **Codex-app layout** — quiet gray user blocks, centered prose column,
   tool activity grouped into a `▶ Worked — N commands` disclosure with an
   activity-rail timeline. Nice, but still "an app".
3. **Single-view experiments** with speaker chips (`YOU ●` / `✦ soul-name`).
4. **Final: pi-style transcript** — the whole view sits on the terminal
   surface (dark; solarized paper in light mode) in monospace. The user's
   prompts are pi's signature **accent-railed bordered blocks**; agent text
   is plain prose on the surface; tool calls are inline `✓ $ cmd` /
   `✓ read path` (amber pulsing `●` while running) with the first ~5 output
   lines dimmed underneath and `… N more lines` expanding in place;
   thinking is a quiet `▸ thinking` disclosure.

# Why it ended here

The founder's guiding instinct for the whole panel is **"you are at the
agent's terminal"** (see the web-pane decision). The speaker-distinction
question resolves the way pi resolves it: the accent-railed block *is* the
"you" marker; everything else is the agent. Any future redesign should be
judged against "does this still read like the terminal?" — bubbles and app
chrome failed that test.

# Consequence: one view

The old Terminal/Chat toggle was removed; the pi-style transcript is *the*
view. `/api/session` (raw ANSI capture) stays server-side for a possible raw
peek. Gotcha from that removal: the `#chat` container kept a stale
`display: none` from the toggle era and nothing ever showed it — when
removing a view toggle, audit the CSS the toggle used to flip.
