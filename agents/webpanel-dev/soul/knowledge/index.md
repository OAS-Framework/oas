---
okf_version: "0.1"
---

# webpanel-dev knowledge base

Long-term knowledge for developing the OAS web control panel — the `oas.web`
marketplace capability (`capabilities/oas-web/`: `bin/oas-web.mjs` server +
`ui/panel.html`). Follow links selectively — read what the task needs.

# Sections

## architecture/

* [architecture/oas-web-architecture.md](architecture/oas-web-architecture.md) - the two-file zero-dependency shape: node:http server on 127.0.0.1, single-file UI, kernel and tmux seams, endpoints, polling model.
* [architecture/transcript-data-sources.md](architecture/transcript-data-sources.md) - pi vs claude session JSONL locations, naming schemes, and tool-result folding differences that parseTranscript normalizes.
* [architecture/color-adaptation.md](architecture/color-adaptation.md) - adaptRgb luminance folding of 24-bit colors and the solarized-light ANSI remap for captured terminal colors.
* [architecture/optimistic-sends-and-indicators.md](architecture/optimistic-sends-and-indicators.md) - pendingSends reconciliation, the fastPollUntil window, and thinking/working indicator states.
* [architecture/workflow-tool-rendering.md](architecture/workflow-tool-rendering.md) - extracting workflow meta from the script source, and why per-step live progress cannot come from the transcript.
* [architecture/multi-workspace-switcher.md](architecture/multi-workspace-switcher.md) - repeatable --dir, team-scope resolution, and the deployment-level workspace dropdown.
* [architecture/raw-key-passthrough-and-host-guard.md](architecture/raw-key-passthrough-and-host-guard.md) - POST /api/keys sends browser keydown bytes into the pane via tmux send-keys -H, routes large payloads through load-buffer/paste-buffer, and rejects non-loopback POST Host/Origin values to prevent DNS-rebinding terminal injection.

## decisions/

* [decisions/pi-style-transcript.md](decisions/pi-style-transcript.md) - why the chat view evolved through bubbles and Codex layouts and settled on a pi-style transcript (terminal feel wins).
* [decisions/hand-rolled-terminal-renderer.md](decisions/hand-rolled-terminal-renderer.md) - the terminal-faithful session surface deliberately renders raw tmux ANSI capture with an in-panel SGR parser instead of xterm.js or another package, with server-reported geometry, cursor state, and history depth used to map capture lines to screen rows.

## lessons/

* [lessons/multiline-send-bracketed-paste.md](lessons/multiline-send-bracketed-paste.md) - literal newlines via send-keys submit per line; multi-line sends need load-buffer + paste-buffer -p.
* [lessons/stale-response-race.md](lessons/stale-response-race.md) - the chatReq request-generation, selection-pinning, and cache-isolation guards against transcript cross-bleed.

## playbooks/

* [playbooks/dev-loop-and-marketplace-refresh.md](playbooks/dev-loop-and-marketplace-refresh.md) - version bumps on every behavior change and the rm-installed-copy + lock-entry + reinstall refresh dance.

## references/

* [references/web-pane-decision.md](references/web-pane-decision.md) - pointer to the founding Decision (oas-expert soul): terminal-direct not aweb, localhost-only, zero dependencies.
