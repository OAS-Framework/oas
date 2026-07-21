# tui-dev knowledge

Starter knowledge for the Terminal Control Pane developer
(`lib/control-pane/model.mjs` + `tui.mjs`, `oas pane`).

## Architecture

* [Model/TUI split and shared data layer](architecture-model-tui-split.md) — the runtime-neutral model vs the ANSI frontend, and why model.mjs changes must be coordinated with the oas.web panel.
* [Card stack rendering](card-stack-rendering.md) — buildCard, in-place expansion, variable-height scrolling, and the rowMap contract for mouse selection.
* [Constellation from parentInstance lineage](constellation-from-parent-lineage.md) — how the tree is built, sorted, and made cycle-proof so malformed metadata never hides a live instance.
* [Session-tail classification — final relevant message wins](session-tail-classification-final-message-wins.md) — classifySessionTail lets the last relevant session-log message decide whether a session is error, ok, or unknown, so a later normal message must override an earlier API error.

## Theme and rendering

* [Theme inference via OSC 11](theme-inference-osc11.md) — raw-mode background query with a 150ms timeout, luminance threshold, and the COLORFGBG fallback chain.
* [Palette discipline lesson](palette-discipline-lesson.md) — hardcoded 38;2/48;2 literals outside applyTheme leak the dark design and break light mode.
* [SGR filtering of captured panes](sgr-filtering-captured-panes.md) — capturedSgr/clipSgr keep colors but strip every non-SGR escape from tmux capture-pane output.
* [TUI session error surfacing — three surfaces, one field](tui-error-marker-placement.md) — Session errors in tui.mjs render from instance.sessionTail on the card title, expanded card, and zoom view, with layout adjusted so the extra error line does not overflow.

## Verification and decisions

* [Testing with pure functions and fake snapshots](testing-pure-functions-fake-snapshots.md) — how to verify the pane headless: parser tests, parseOsc11 shapes, renderFrame against hand-built snapshots.
* [Control Pane decisions (reference)](reference-control-pane-decisions.md) — pointers to the binding decisions in the oas-expert soul (standalone read-only TUI, v3 cards, visual language, web pane).

## Operational lessons

* [Reviewer capability agent stalls can leave recoverable findings in session logs](reviewer-agent-stall-failure-mode.md) — A reviewer spawned with attached work may stall after reading the diff while oas still reports it idle, and the only recoverable findings may be in the pi session jsonl thinking blocks.
