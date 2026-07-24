---
type: Decision
title: One input surface — the terminal's own input line
description: The panel must not keep a separate chat composer; all typing and pasting goes through raw /api/keys passthrough so the terminal's own input line is the single input surface.
tags: [desktop-backend, composer, keys, ux]
timestamp: 2026-07-22
---

# Decision

The human direction on 2026-07-22 was explicit: "the input box for talking to
the agent should be the terminal one on the web panel too. We should not have
a separate one."

The panel removed the `#composer` / `#msg` textarea and the `/api/send` +
`sendText` path. All input now flows through `POST /api/keys` into the pane:
regular typing becomes raw tmux key bytes and paste events are delivered as
bracketed paste.

# Consequences

- The terminal is the sole interaction surface, consistent with the founding
  terminal-direct decision.
- Selecting or clicking a session pane focuses key capture for that pane.
- Browser keys are not captured while the sidebar filter input has focus.
- Do not reintroduce a separate chat composer unless this decision is reversed.

# Related concepts

- The byte path is captured in
  [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md).
- The founding shape is referenced in
  [Web pane decision](/references/desktop-panel-decisions.md).
