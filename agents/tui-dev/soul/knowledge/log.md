# Knowledge Log

## 2026-07-23

- **Update**: [anchor-tmux-attach-targets.md](anchor-tmux-attach-targets.md)
  — recorded the `set-option -t` exception: viewer-local option targets do not accept `=` anchors, so only unique random viewer session names may use that unanchored form.
- **Update**: [desktop-terminal-direct-attach.md](desktop-terminal-direct-attach.md)
  — replaced the grouped viewer session description with the independent link-window viewer shape and source-window-death behavior.
- **Removal**: [desktop-terminal-grouped-viewer-sessions.md](desktop-terminal-grouped-viewer-sessions.md)
  — superseded by [desktop-terminal-link-window-viewer-isolation.md](desktop-terminal-link-window-viewer-isolation.md) because grouped sessions share window membership and can escape to sibling windows.
- **Creation**: [desktop-terminal-link-window-viewer-isolation.md](desktop-terminal-link-window-viewer-isolation.md)
  — promoted the lesson that desktop terminal viewers need independent sessions containing only a link-window to the exact source window, plus locked prefix/root navigation keys.
- **Update**: [desktop-terminal-direct-attach.md](desktop-terminal-direct-attach.md)
  — merged the grouped-viewer-session follow-up so direct node-pty attach uses a per-tab grouped session rather than the durable session's shared current-window selection.
- **Creation**: [desktop-terminal-grouped-viewer-sessions.md](desktop-terminal-grouped-viewer-sessions.md)
  — promoted the decision that desktop terminal tabs need per-tab tmux viewer sessions grouped to the durable session, with independent current-window selection and exact cleanup.
- **Update**: [desktop-shell-view-integration-lessons.md](desktop-shell-view-integration-lessons.md)
  — reframed older-server inline degradation as defense-in-depth and linked the identity/version reuse probe.
- **Creation**: [server-reuse-identity-probe.md](server-reuse-identity-probe.md)
  — promoted the lesson that a workspace/liveness probe is not enough to reuse an existing desktop server; capability+version must exactly match the local manifest or the desktop should spawn its own server.
- **Update**: [regression-tests-bug-layer.md](regression-tests-bug-layer.md)
  — merged the mutation-check discipline from tui-dev-desktop-shell notes: before claiming guard/order regression coverage, delete the fix and verify the new tests fail.
- **Update**: [desktop-terminal-direct-attach.md](desktop-terminal-direct-attach.md)
  — merged the exact-match attach-target lesson so node-pty attach uses validated `=session:=window` targets instead of unanchored prefix-matchable `session:window`.
- **Creation**: [anchor-tmux-attach-targets.md](anchor-tmux-attach-targets.md)
  — promoted the lesson that every desktop-constructed tmux `-t` target must be `=`-anchored and component-validated so stale rosters fail loudly instead of attaching keystrokes to the wrong window.
- **Triage**: dropped the aweb awakening coda from node-test-recursion-worktrees.md because it described transient messaging-layer behavior, not durable tui-dev desktop-shell knowledge.
- **Update**: [testing-pure-functions-fake-snapshots.md](testing-pure-functions-fake-snapshots.md)
  — replaced the bare full-repo `node --test` suggestion with the pinned-glob test-script rule from the node test recursion lesson.
- **Creation**: [node-test-recursion-worktrees.md](node-test-recursion-worktrees.md)
  — promoted the lesson that bare `node --test` in an OAS repo discovers stale sibling agent worktree suites unless full-repo tests are pinned to explicit globs.
- **Triage**: dropped the aweb late-awakening addendum from tui-dev-desktop-shell notes because it described a transient messaging incident already reported to the OAS/aweb owners, not durable tui-dev desktop-shell knowledge.
- **Update**: [async-mount-close-race.md](async-mount-close-race.md)
  — linked the companion regression-test-layer lesson so lifecycle helpers are not mistaken for coverage of their caller composition.
- **Creation**: [regression-tests-bug-layer.md](regression-tests-bug-layer.md)
  — promoted the reviewer finding that regressions must execute the layer that had the bug, extracting desktop terminal composition behind injectable dependencies when needed.
- **Update**: [async-mount-close-race.md](async-mount-close-race.md)
  — merged the terminal lifecycle `onReady` ordering lesson from tui-dev-desktop-shell notes so post-acquisition handlers, observers, and focus setup happen before settle or not at all.
- **Update**: [pkill-scoping-discipline.md](pkill-scoping-discipline.md)
  — merged the tmux prefix-matching reviewer incident follow-up from tui-dev-desktop-shell notes, including exact `=`-anchored targets and stale-worktree caution.

## 2026-07-22

- **Update**: [async-mount-close-race.md](async-mount-close-race.md)
  — merged the terminal pty close-during-pending-open lifecycle lesson from tui-dev-desktop-shell notes, including late pty release and silent closed-tab rejection handling.
- **Update**: [desktop-shell-view-integration-lessons.md](desktop-shell-view-integration-lessons.md)
  — replaced endpoint-by-endpoint workspace pinning guidance with route-family classification from tui-dev-desktop-shell notes.
- **Creation**: [route-family-workspace-pinning.md](route-family-workspace-pinning.md)
  — promoted the route-family workspace pinning lesson from tui-dev-desktop-shell notes.
- **Update**: [async-mount-close-race.md](async-mount-close-race.md)
  — merged the reserved-key waiter follow-up from tui-dev-desktop-shell notes so fast reopens queue behind cleanup instead of being dropped.
- **Update**: [async-mount-close-race.md](async-mount-close-race.md)
  — merged lifecycle fulfillment tracking and dedup-key reservation follow-on races from tui-dev-desktop-shell notes.
- **Creation**: [async-mount-close-race.md](async-mount-close-race.md)
  — promoted the async close-during-mount cleanup race lesson from tui-dev-desktop-shell notes.
- **Update**: [view-mount-disposer-contract.md](view-mount-disposer-contract.md)
  — linked the async mount close race to the per-mount disposer contract.
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
