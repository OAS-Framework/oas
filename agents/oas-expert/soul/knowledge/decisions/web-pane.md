---
type: Decision
title: Web pane — browser control panel as the oas.web marketplace capability
status: superseded
description: A local web control panel ("Slack of the agents") ships as the oas.web marketplace capability contributing `oas web` — a localhost Node server (no deps beyond node) reusing lib/control-pane/model.mjs; xterm-style session views via tmux capture-pane polling; talking to an agent types directly into its tmux session (send-keys), NOT via aweb — the interaction model is "you are at the agent's terminal"; Jira epic + roster panel via acli when the instance has jira meta. Electron rejected; Tauri/app-mode deferred as packaging.
tags: [web, control-pane, ui, capability, tmux, jira]
timestamp: 2026-07-24
---

Decided with the founder, 2026-07-17.

# Supersession

The [desktop panel succession decision](/decisions/desktop-panel-succession.md)
supersedes this concept's continuing product and capability-packaging direction.
This concept remains the historical source for the localhost trust boundary,
tmux-direct interaction, and backend behavior migrated into desktop.

# What it is

A browser UI on localhost showing every local instance (name, soul, repo,
running state, task), the full live session of any instance, a Jira panel
(the epic an instance works, and the epic's Agent Roster table) when the
jira capability is active, and an input box to talk to the agent.

# Key choices

- **Terminal-direct interaction, not aweb.** The founder wants the feel of
  sitting at the agent's terminal: the input box sends keystrokes into the
  instance's tmux window (`tmux send-keys`), and the session view streams
  the pane back (`tmux capture-pane -p -e`, polled). This works identically
  for pi and claude sessions — tmux is the runtime-agnostic seam. aweb
  remains the *inter-agent* messaging layer; the panel is the *human*
  window into a session. (An aweb chat sidebar remains a possible later
  addition, explicitly out of scope for P1.)
- **Delivery: localhost web, not Electron.** The server runs where the
  agents are; remote workstations work via ssh port-forward. Electron would
  bundle Chromium, bind to desktop/macOS, and foreclose the remote case.
  App-feel later via Chrome `--app=` mode or a Tauri wrapper — packaging
  choices that reuse the same server, deliberately deferred.
- **Packaging: `oas.web` marketplace capability**, not kernel code — keeps
  the kernel lean, exercises the marketplace path, versions independently.
  It contributes the operational command `oas web [--port] [--open]`.
  Trusted at acquisition like all marketplace packages.
- **Zero npm dependencies.** node:http + a hand-rolled WebSocket-free
  design: the UI polls JSON endpoints (matches the TUI's refresh loop;
  SSE/WebSockets can come later if polling chafes). Binds 127.0.0.1 only —
  the server can type into terminals; it must never listen publicly.

# Data seams (all pre-existing)

- Roster: `lib/control-pane/model.mjs` `collectControlPane(root)` (already
  aggregates instance.json + tmux + git + TASK/STATE excerpts) — the web
  server imports the kernel through `oas root` resolution like other
  marketplace packages.
- Session: `capturePreview(instance, lines)` → ANSI text → rendered in the
  browser with a small ANSI-to-HTML converter (SGR colors only, mirroring
  the TUI's filtering).
- Send: `tmux send-keys -t <session>:<window> -l <text>` + `Enter`.
- Jira: instance.json `capabilityMeta["oas.jira"]` carries {label, site,
  project}; epic discovery = `acli jira workitem search --jql "labels =
  <label> AND type = Epic"` (and parents of labeled tickets); roster = the
  `## Agent Roster` table parsed from the epic description.

# Phasing

P1: roster + live session view + type-into-terminal. P2: Jira epic/roster
panel. P3 (deferred): aweb chat sidebar, SSE streaming, Tauri wrapper.
