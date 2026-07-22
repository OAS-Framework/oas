# Knowledge Log

## 2026-07-22

- **Creation**: [view-mount-disposer-contract.md](view-mount-disposer-contract.md)
  — promoted the backward-compatible `mount(el, ctx)` per-mount disposer contract from tui-dev-desktop-shell notes.
- **Update**: [desktop-shell-layout.md](desktop-shell-layout.md)
  — documented the view-host disposer return contract in the desktop shell layout reference.
- **Update**: [desktop-shell-view-integration-lessons.md](desktop-shell-view-integration-lessons.md)
  — merged the multi-mount markdown/diff disposer lesson and diff workspace-scoping fixes from tui-dev-desktop-shell notes.
- **Creation**: [pkill-scoping-discipline.md](pkill-scoping-discipline.md)
  — promoted the live desktop testing process-kill scoping discipline lesson from tui-dev-desktop-shell notes.
- **Creation**: [electron-renderer-native-esm-dependencies.md](electron-renderer-native-esm-dependencies.md)
  — promoted the importmap/CSP hash/highlight.js dual-package lesson from tui-dev-desktop-shell notes.
- **Update**: [desktop-shell-view-integration-lessons.md](desktop-shell-view-integration-lessons.md)
  — merged the shell-owned picker-tab rule for views that need per-tab context from tui-dev-desktop-shell notes.
- **Update**: [desktop-shell-view-integration-lessons.md](desktop-shell-view-integration-lessons.md)
  — merged the `/api/brain` workspace-pinning endpoint coupling lesson from tui-dev-desktop-shell notes.
- **Update**: [desktop-shell-view-integration-lessons.md](desktop-shell-view-integration-lessons.md)
  — merged fetch-body serialization, workspace-scoped terminal open, and async tab-dedup race lessons from tui-dev-desktop-shell notes.
- **Creation**: [desktop-shell-view-integration-lessons.md](desktop-shell-view-integration-lessons.md)
  — promoted desktop shell ported-view integration lessons from tui-dev-desktop-shell notes.
- **Creation**: [url-resolution-ssrf-footgun.md](url-resolution-ssrf-footgun.md)
  — promoted the WHATWG URL resolution SSRF lesson from tui-dev-desktop-shell notes.
- **Creation**: [desktop-shell-hardening-review-lessons.md](desktop-shell-hardening-review-lessons.md)
  — promoted desktop shell security/workspace-selection/toolchain audit review findings from tui-dev-desktop-shell notes.
- **Creation**: [desktop-shell-layout.md](desktop-shell-layout.md)
  — promoted the desktop shell package layout, view-host contract, coordination rule, and node-pty rebuild quirk from tui-dev-desktop-shell notes.
- **Creation**: [desktop-terminal-direct-attach.md](desktop-terminal-direct-attach.md)
  — promoted the binding decision that the desktop terminal directly attaches tmux via node-pty/xterm IPC, leaving the session durable and the legacy HTTP fallback untouched.
- **Creation**: [electron-headless-verification.md](electron-headless-verification.md)
  — promoted Electron headless verification lessons for CDP renderer checks, Electron-ABI native-module checks, and signal shutdown handling.
- **Creation**: [flat-card-surface-decision.md](flat-card-surface-decision.md)
  — per-card background fills removed in both themes after maintainer
  feedback; selection-only highlight; feature chip became violet text.
  palette-discipline lesson still applies (no hardcoded 38;2 outside
  applyTheme).

## 2026-07-21

- **Removed**: theme-inference-osc11.md — superseded by
  [named-themes-decision.md](named-themes-decision.md) (dark + solarized,
  explicit selection; OSC 11/COLORFGBG detection deleted from tui.mjs).

## 2026-07-20

- Seeded the starter bundle from the framework sessions and source: model/TUI
  architecture, card stack rendering, constellation lineage, OSC 11 theme
  inference, the palette-discipline lesson, SGR capture filtering, the
  headless testing playbook, and a reference to the Control Pane decisions in
  the oas-expert soul.
