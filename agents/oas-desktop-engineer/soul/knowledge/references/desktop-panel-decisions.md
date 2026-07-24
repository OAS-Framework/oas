---
type: Reference
title: Founding and succession decision records (oas-expert soul)
description: Canonical decisions in the oas-expert soul — web-pane.md fixed terminal-direct interaction, localhost-only trust boundary, and zero backend dependencies; desktop-panel-succession.md moved ownership to the desktop app and retired the browser panel and oas.web capability.
tags: [decision, desktop, reference, trust-boundary]
timestamp: 2026-07-24
---

Read the full records at
`agents/oas-expert/soul/knowledge/decisions/web-pane.md` and
`agents/oas-expert/soul/knowledge/decisions/desktop-panel-succession.md`
(framework repo). Do not duplicate them; what the desktop engineer must
internalize:

- **Terminal-direct, NOT aweb.** The interaction model is "you are sitting at
  the agent's terminal": input goes via tmux into the live session; the view
  streams the session back. aweb stays the *inter-agent*
  messaging layer; the app is the *human* window. An aweb chat sidebar is
  explicitly deferred — do not sneak it in.
- **Zero npm dependencies in the backend; binds 127.0.0.1 only** — the trust
  boundary is the loopback interface because the process can type into
  terminals. These invariants survived the succession unchanged.
- **Succession (2026-07): the Electron desktop app owns the panel.** The
  `oas.web` marketplace capability and browser panel were absorbed into
  `packages/desktop/` (server bundled with the app); `lib/control-pane/` and
  `oas pane` were retired — the roster model moved into the desktop server.

