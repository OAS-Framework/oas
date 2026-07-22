# tui-dev knowledge

Starter knowledge for the Terminal Control Pane developer
(`lib/control-pane/model.mjs` + `tui.mjs`, `oas pane`).

## Desktop shell

* [Desktop shell view-host contract and layout](desktop-shell-layout.md) — Where things live in packages/desktop and how feature views integrate — mount(el, ctx) may return a disposer, unmount() remains the module-level fallback, and ctx = { api, openFile, openTerminal } is provided by the shell.
* [View contract extension — mount() may return a per-mount disposer](view-mount-disposer-contract.md) — The desktop view host prefers a disposer function returned by mount(el, ctx) over module-level unmount() so multi-tab views can clean up independently while older single-tab views keep their original semantics.
* [Async mount close race — cleanup must wait for settle](async-mount-close-race.md) — When a tab host supports async mount() returning a disposer, a close during the pending mount must defer cleanup until mount settles and then run that mount's disposer.
* [Desktop shell view integration lessons](desktop-shell-view-integration-lessons.md) — Ported panel views rely on key-deduped tabs, per-mount disposers for multi-tab views, context-owning picker tabs, .mjs loader naming, workspace-aware API pinning, exactly-once Fetch body serialization, and inline degradation when older shared servers lack endpoints.
* [Electron renderer native ESM dependencies](electron-renderer-native-esm-dependencies.md) — Bare imports in the unbundled Electron renderer need an importmap, the importmap's inline script needs a CSP hash, and highlight.js must be bundled from its dual-package shim into browser-loadable ESM.
* [Electron desktop shell hardening review lessons](desktop-shell-hardening-review-lessons.md) — First desktop shell review findings to preserve: block same-window navigation and foreign-frame IPC, verify oas-web serves the requested workspace, and audit Electron/toolchain dev dependencies at scaffold time.
* [WHATWG URL resolution is an SSRF footgun in privileged proxies](url-resolution-ssrf-footgun.md) — new URL(path, base) resolves protocol-relative ("//host/x") and backslash ("/\\host/x") inputs to a different origin, so a privileged fetch proxy must check url.origin against the base origin, not just require a leading slash.
* [Desktop terminal is a direct tmux attach via node-pty](desktop-terminal-direct-attach.md) — The desktop app's integrated terminal spawns node-pty running `tmux attach-session -t <session>:<window>` and pipes bytes over IPC to xterm.js — no capture-pane polling, no send-keys, no WebSocket bridge; closing the tab kills the pty only.

## Architecture

* [Model/TUI split and shared data layer](architecture-model-tui-split.md) — the runtime-neutral model vs the ANSI frontend, and why model.mjs changes must be coordinated with the oas.web panel.
* [Card stack rendering](card-stack-rendering.md) — buildCard, in-place expansion, variable-height scrolling, and the rowMap contract for mouse selection.
* [Constellation from parentInstance lineage](constellation-from-parent-lineage.md) — how the tree is built, sorted, and made cycle-proof so malformed metadata never hides a live instance.

## Theme and rendering

* [Flat card surface decision](flat-card-surface-decision.md) — cards share the panel background; only selection gets a step; feature chips are text, not blocks.
* [Named themes decision](named-themes-decision.md) — dark (default) + solarized, explicit --theme/OAS_PANE_THEME selection; OSC 11/COLORFGBG inference removed.
* [Palette discipline lesson](palette-discipline-lesson.md) — hardcoded 38;2/48;2 literals outside applyTheme leak the dark design and break light mode.
* [SGR filtering of captured panes](sgr-filtering-captured-panes.md) — capturedSgr/clipSgr keep colors but strip every non-SGR escape from tmux capture-pane output.

## Verification and decisions

* [Testing with pure functions and fake snapshots](testing-pure-functions-fake-snapshots.md) — how to verify the pane headless: parser tests, renderFrame against hand-built snapshots.
* [Verifying an Electron app headlessly via CDP and ELECTRON_RUN_AS_NODE](electron-headless-verification.md) — How to drive and verify an Electron shell without a human at the GUI — remote-debugging-port + CDP Runtime.evaluate for the renderer, ELECTRON_RUN_AS_NODE for native-module (node-pty) checks under the Electron ABI.
* [Scope every pkill during live desktop testing](pkill-scoping-discipline.md) — Broad `pkill -f` patterns during app testing can kill foreign processes machine-wide — always scope patterns to your own worktree path or exact PIDs; an unscoped `pkill -f "oas-web.mjs start"` from another process killed/restarted servers it did not own.
* [Control Pane decisions (reference)](reference-control-pane-decisions.md) — pointers to the binding decisions in the oas-expert soul (standalone read-only TUI, v3 cards, visual language, web pane).
