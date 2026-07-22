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
* [architecture/color-adaptation.md](architecture/color-adaptation.md) - Captured terminal colors are authored for dark backgrounds, so the panel's light theme remaps standard ANSI colors, folds too-bright 24-bit foregrounds down to a readable lightness ceiling, and suppresses near-default truecolor backgrounds that look like accidental highlights.
* [architecture/optimistic-sends-and-indicators.md](architecture/optimistic-sends-and-indicators.md) - pendingSends reconciliation, the fastPollUntil window, and thinking/working indicator states.
* [architecture/workflow-tool-rendering.md](architecture/workflow-tool-rendering.md) - extracting workflow meta from the script source, and why per-step live progress cannot come from the transcript.
* [architecture/multi-workspace-switcher.md](architecture/multi-workspace-switcher.md) - repeatable --dir, team-scope resolution, and the deployment-level workspace dropdown.
* [architecture/raw-key-passthrough-and-host-guard.md](architecture/raw-key-passthrough-and-host-guard.md) - POST /api/keys is the panel's sole text-input path, sending browser keydown bytes into the focused pane via tmux send-keys -H, routing large or pasted payloads through load-buffer/paste-buffer, and rejecting non-loopback POST Host/Origin values.
* [architecture/split-panes-and-compact-shell.md](architecture/split-panes-and-compact-shell.md) - v0.7.0 replaced the single session surface with per-pane session state in an editor-style split row, plus a persisted collapsible sidebar and 32px compact pane header.

## decisions/

* [decisions/pi-style-transcript.md](decisions/pi-style-transcript.md) - why the chat view evolved through bubbles and Codex layouts and settled on a pi-style transcript (terminal feel wins).
* [decisions/hand-rolled-terminal-renderer.md](decisions/hand-rolled-terminal-renderer.md) - the terminal-faithful session surface deliberately renders raw tmux ANSI capture with an in-panel SGR parser instead of xterm.js or another package, with server-reported geometry, cursor state, and history depth used to map capture lines to screen rows.
* [decisions/terminal-input-unification.md](decisions/terminal-input-unification.md) - The panel must not keep a separate chat composer; all typing and pasting goes through raw /api/keys passthrough so the terminal's own input line is the single input surface.

## lessons/

* [lessons/multiline-send-bracketed-paste.md](lessons/multiline-send-bracketed-paste.md) - Any path that delivers text containing newlines into an agent pane must use load-buffer plus paste-buffer -p; raw send-keys/newline delivery submits each line separately or can execute pasted lines one by one.
* [lessons/stale-response-race.md](lessons/stale-response-race.md) - the chatReq request-generation, selection-pinning, and cache-isolation guards against transcript cross-bleed.

## playbooks/

* [playbooks/dev-loop-and-marketplace-refresh.md](playbooks/dev-loop-and-marketplace-refresh.md) - version bumps on every behavior change and the rm-installed-copy + lock-entry + reinstall refresh dance.

## references/

* [references/web-pane-decision.md](references/web-pane-decision.md) - pointer to the founding Decision (oas-expert soul): terminal-direct not aweb, localhost-only, zero dependencies.
