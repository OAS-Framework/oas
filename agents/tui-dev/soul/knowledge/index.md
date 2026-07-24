# tui-dev knowledge

Starter knowledge for the Terminal Control Pane developer
(`lib/control-pane/model.mjs` + `tui.mjs`, `oas pane`).

## Desktop shell

* [Desktop shell view-host contract and layout](desktop-shell-layout.md) — Where things live in packages/desktop and how feature views integrate — mount(el, ctx) may return a disposer, unmount() remains the module-level fallback, and ctx = { api, openFile, openTerminal } is provided by the shell.
* [View contract extension — mount() may return a per-mount disposer](view-mount-disposer-contract.md) — The desktop view host prefers a disposer function returned by mount(el, ctx) over module-level unmount() so multi-tab views can clean up independently while older single-tab views keep their original semantics.
* [Async resource lifecycles must handle close during pending acquisition](async-mount-close-race.md) — When a desktop owner can close during async mount or terminal open, lifecycle state must track closed/settled/fulfilled, release late materialized resources, reserve dedup keys until cleanup completes, and run setup inside `onReady` before settle.
* [Desktop shell view integration lessons](desktop-shell-view-integration-lessons.md) — Ported panel views rely on key-deduped tabs, per-mount disposers for multi-tab views, context-owning picker tabs, .mjs loader naming, route-family workspace pinning, exact server identity/version reuse checks, exactly-once Fetch body serialization, and inline degradation when older shared servers lack endpoints.
* [Scope classification by route family, not endpoint enumeration](route-family-workspace-pinning.md) — Desktop proxy workspace pinning must classify whole instance-addressed route families instead of enumerating individual endpoints so new routes fail safe rather than silently unpinned.
* [Server reuse needs an identity probe, not just a liveness probe](server-reuse-identity-probe.md) — Desktop server reuse must compare an identity/version response with the local checkout's manifest, because a server that answers workspace endpoints can still be an incompatible older or newer install.
* [Electron renderer native ESM dependencies](electron-renderer-native-esm-dependencies.md) — Bare imports in the unbundled Electron renderer need an importmap, the importmap's inline script needs a CSP hash, and highlight.js must be bundled from its dual-package shim into browser-loadable ESM.
* [Electron desktop shell hardening review lessons](desktop-shell-hardening-review-lessons.md) — First desktop shell review findings to preserve: block same-window navigation and foreign-frame IPC, verify oas-web serves the requested workspace, and audit Electron/toolchain dev dependencies at scaffold time.
* [WHATWG URL resolution is an SSRF footgun in privileged proxies](url-resolution-ssrf-footgun.md) — new URL(path, base) resolves protocol-relative ("//host/x") and backslash ("/\\host/x") inputs to a different origin, so a privileged fetch proxy must check url.origin against the base origin, not just require a leading slash.
* [Desktop terminal is a direct tmux attach via node-pty](desktop-terminal-direct-attach.md) — The desktop app's integrated terminal spawns node-pty running `tmux attach-session` against an isolated per-tab tmux viewer session that contains only a link-window to the exact source window and pipes bytes over IPC to xterm.js.
* [Grouped sessions share membership — link-window isolates viewer windows](desktop-terminal-link-window-viewer-isolation.md) — tmux grouped sessions isolate current-window selection but share window membership, so desktop terminal viewers must be independent sessions with only a link-window to the exact source window and disabled prefix/root window navigation.
* [Provision locked tmux key tables as explicit allow-lists](provision-locked-key-tables.md) — A tmux viewer key-table lock must be a real table containing only approved bindings, because a nonexistent table also disables root conveniences such as WheelUpPane scrollback that xterm.js cannot recover from alternate-screen history.
* [Anchor every tmux target the desktop constructs](anchor-tmux-attach-targets.md) — tmux prefix-matches unanchored targets, so desktop code should build `=session:=window` through a validating helper for targets that accept anchors and fail loudly when the exact window is gone.

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
* [Bare node --test recurses into sibling agent worktrees](node-test-recursion-worktrees.md) — In an OAS repo that contains agents/*/instances/*/work, bare node --test discovers stale suites from sibling worktrees; pin explicit test globs and guard CLI subprocess tests with inert environment.
* [Verifying an Electron app headlessly via CDP and ELECTRON_RUN_AS_NODE](electron-headless-verification.md) — How to drive and verify an Electron shell without a human at the GUI — remote-debugging-port + CDP Runtime.evaluate for the renderer, ELECTRON_RUN_AS_NODE for native-module (node-pty) checks under the Electron ABI.
* [Regression tests must exercise the layer that had the bug](regression-tests-bug-layer.md) — A regression test only pins a bug if it executes the code layer whose ordering or guard was wrong; extract that layer behind injectable dependencies, assert order, and mutation-check by reverting the fix before claiming coverage.
* [Scope destructive cleanup during live desktop testing](pkill-scoping-discipline.md) — Broad `pkill -f` patterns and unanchored tmux targets during app testing can kill foreign processes machine-wide — always scope patterns to your own worktree path, exact PIDs, or exact tmux targets.
* [Control Pane decisions (reference)](reference-control-pane-decisions.md) — pointers to the binding decisions in the oas-expert soul (standalone read-only TUI, v3 cards, visual language, web pane).
