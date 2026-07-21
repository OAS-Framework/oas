---
type: Reference
title: Founding decision record for the web panel (oas-expert soul)
description: The canonical Decision for oas.web lives in the oas-expert soul at agents/oas-expert/soul/knowledge/decisions/web-pane.md and fixes three non-negotiables — terminal-direct interaction (tmux, not aweb), localhost-only trust boundary, and zero npm dependencies.
tags: [decision, oas-web, reference, trust-boundary]
timestamp: 2026-07-21
---

Read the full record at
`agents/oas-expert/soul/knowledge/decisions/web-pane.md` (framework repo).
Do not duplicate it; what a webpanel developer must internalize:

- **Terminal-direct, NOT aweb.** The interaction model is "you are sitting at
  the agent's terminal": input goes via `tmux send-keys` into the live
  session; the view streams the session back. aweb stays the *inter-agent*
  messaging layer; the panel is the *human* window. An aweb chat sidebar is
  explicitly deferred (P3) — do not sneak it in.
- **Localhost web, not Electron.** The server runs where the agents run;
  remote = ssh port-forward. App-feel later via Chrome `--app=` or Tauri —
  packaging that reuses the same server.
- **`oas.web` marketplace capability, not kernel code** — versions
  independently, exercises the marketplace path, contributes `oas web`.
- **Zero npm dependencies; binds 127.0.0.1 only** — the trust boundary is
  the loopback interface because the process can type into terminals.

Phasing per the decision: P1 roster + live session + type-into-terminal;
P2 Jira epic/roster panel; P3 (deferred) aweb sidebar, SSE, Tauri.
