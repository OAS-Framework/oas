# Knowledge Log

## 2026-07-22

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
