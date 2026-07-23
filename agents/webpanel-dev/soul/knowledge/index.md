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
* [architecture/multi-workspace-switcher.md](architecture/multi-workspace-switcher.md) - repeatable --dir with team-scope resolution (duplicates collapse), the deployment-level workspace dropdown shown only when more than one workspace is watched, and instance-name APIs passing ?ws= end to end so same-named instances resolve inside the selected workspace.
* [architecture/raw-key-passthrough-and-host-guard.md](architecture/raw-key-passthrough-and-host-guard.md) - POST /api/keys is the panel's sole text-input path, sending browser keydown bytes into the logically focused pane via tmux send-keys -H, routing large or pasted payloads through load-buffer/paste-buffer, forcing a short-tail repaint so echo is visible, and enforcing loopback Host on every request plus loopback Origin on POSTs.
* [architecture/spawn-endpoint.md](architecture/spawn-endpoint.md) - POST /api/spawn treats browser-supplied agentsRoot as a selector into the server's workspace roots, while task "" intentionally spawns an awaiting-instructions instance.
* [architecture/agent-brain-endpoint-and-view.md](architecture/agent-brain-endpoint-and-view.md) - GET /api/brain resolves agent names through kernel lookup seams, expands capability-agent skills from manifest leaf or parent-tree paths, returns only artifact paths, and feeds the desktop renderer's contract-based brain view.
* [architecture/split-panes-and-compact-shell.md](architecture/split-panes-and-compact-shell.md) - v0.7.0 replaced the single session surface with per-pane session state in an editor-style split row, plus a persisted collapsible sidebar and 32px compact pane header.
* [architecture/desktop-renderer-views-port.md](architecture/desktop-renderer-views-port.md) - The oas-web panel maps to desktop renderer views under packages/desktop/renderer/views/ as plain mount/unmount ES modules, with a same-origin harness proxy for development.

## decisions/

* [decisions/pi-style-transcript.md](decisions/pi-style-transcript.md) - why the chat view evolved through bubbles and Codex layouts and settled on a pi-style transcript (terminal feel wins).
* [decisions/hand-rolled-terminal-renderer.md](decisions/hand-rolled-terminal-renderer.md) - the terminal-faithful session surface deliberately renders raw tmux ANSI capture with an in-panel SGR parser instead of xterm.js or another package, with server-reported geometry, cursor state, and history depth used to map capture lines to screen rows.
* [decisions/terminal-input-unification.md](decisions/terminal-input-unification.md) - The panel must not keep a separate chat composer; all typing and pasting goes through raw /api/keys passthrough so the terminal's own input line is the single input surface.

## lessons/

* [lessons/harness-proxy-origin-guard.md](lessons/harness-proxy-origin-guard.md) - A dev or harness proxy in front of oas-web must enforce the loopback Host/Origin guard at its own boundary before serving static files or proxying, and forward the browser's real Origin rather than rewriting it.
* [lessons/shared-renderer-harness-enumeration-test.md](lessons/shared-renderer-harness-enumeration-test.md) - Desktop renderer views should share one harness whose tabs are checked by enumerating every shipped mount-exporting view, so a new view fails tests until it has a tab and standalone dev-* harnesses stay deleted.
* [lessons/behavioral-security-regressions.md](lessons/behavioral-security-regressions.md) - Guard regressions must drive the real boundary with forged requests and a fake upstream, because source-string checks pass when the guard is inverted, unreachable, or no longer returns 403.
* [lessons/manifest-compat-floor-core-apis.md](lessons/manifest-compat-floor-core-apis.md) - When oas-web starts calling a new core.* helper, capabilities/oas-web/oas.json compatibility.oas must be raised to the kernel version that helper first shipped in, and the manifest-floor regression test's API map should be extended with that helper.
* [lessons/fast-attach-cache-tail-backfill.md](lessons/fast-attach-cache-tail-backfill.md) - Attach latency is dominated by rebuilding the control-pane registry and serial tmux round trips, so keep a short registry cache, merge pane metadata queries, paint a cached or short tail first, and deep-backfill later with the requested line count in the render signature.
* [lessons/logical-key-routing-not-dom-focus.md](lessons/logical-key-routing-not-dom-focus.md) - Binding keydown to the terminal element made typing silently die whenever a button or header click moved DOM focus while the pane still looked focused; route keys with a window listener to the logical focused pane and ignore real editable controls.
* [lessons/workspace-scoped-instance-routing.md](lessons/workspace-scoped-instance-routing.md) - Instance names are only unique within a workspace, so instance-name APIs must forward the selected ?ws= end to end — views build per-instance paths through a shared ws-appending helper, and the server's findInstance(name, wsId) fails closed inside that workspace rather than falling back to the first global match.
* [lessons/snapshot-collection-off-thread.md](lessons/snapshot-collection-off-thread.md) - The panel's key latency tail came from synchronous collectControlPane work blocking the single-threaded server, so /api/panel and findInstance should serve from a background child-process snapshot instead of collecting inline on request paths.
* [lessons/workspace-scoped-snapshot-lookups.md](lessons/workspace-scoped-snapshot-lookups.md) - When an endpoint has resolved a workspace, subsequent roster-snapshot lookups must pass that workspace id; unscoped first-match lookup can mislabel same-named instances from another workspace.
* [lessons/typing-echo-visibility.md](lessons/typing-echo-visibility.md) - Keys can reach tmux while the panel still appears unable to type if the UI does not force a terminal repaint and snap to the bottom row after input; key flushes should force a short-tail refresh and pin the prompt briefly.
* [lessons/multiline-send-bracketed-paste.md](lessons/multiline-send-bracketed-paste.md) - Any path that delivers text containing newlines into an agent pane must use load-buffer plus paste-buffer -p; raw send-keys/newline delivery submits each line separately or can execute pasted lines one by one.
* [lessons/tmux-anchored-targets-and-display-message-fallback.md](lessons/tmux-anchored-targets-and-display-message-fallback.md) - tmux `-t` prefix-matches unanchored targets, so oas-web builds validated `=session:=window` targets and uses `list-panes` rather than `display-message` when a missing pane must fail closed.
* [lessons/stale-response-race.md](lessons/stale-response-race.md) - Every async result that depends on the selected workspace — roster/agent refreshes, Jira fetches, and spawn completions — must capture a global workspace generation as well as any per-path request ticket, because same-named instances and workspace switches can let stale paints or terminal-opening actions land in the wrong workspace.
* [lessons/race-guard-tests-overlap-generations.md](lessons/race-guard-tests-overlap-generations.md) - Request-generation guard tests must keep two in-flight generations alive, resolve newer before older, and mutation-check that removing the generation comparison fails; sequential or dispose-only coverage proves only the disposal half of the guard.
* [lessons/guard-both-completion-paths.md](lessons/guard-both-completion-paths.md) - Async renderer selections must mint a fresh generation for every user action and check one ownership predicate on both success and error completions, or stale rejections can overwrite a newer render.
* [lessons/release-ui-locks-every-exit-path.md](lessons/release-ui-locks-every-exit-path.md) - Any lock or disabled control taken before an async operation must be released on every completion path, but only by the request that still owns that UI state.
* [lessons/split-generation-counters-per-request-kind.md](lessons/split-generation-counters-per-request-kind.md) - Do not let a child selection request share the same generation token as the roster refresh that populates it; each request kind gets its own counter, and a parent refresh may cancel child loads but child loads must not cancel the parent refresh.
* [lessons/shared-form-operation-token.md](lessons/shared-form-operation-token.md) - When one form can start overlapping async operations, capture a per-operation token and guard every post-await mutation of that shared UI — success, error, field clearing, and finally control reset — so a stale completion cannot corrupt or re-enable a newer operation.
* [lessons/file-endpoint-realpath-guard.md](lessons/file-endpoint-realpath-guard.md) - The /api/file endpoint must realpath both the requested file and each allowed root, then require exact-root or root-plus-separator containment so dotdot, symlink, and sibling-prefix escapes fail closed.
* [lessons/loopback-host-guard-all-requests.md](lessons/loopback-host-guard-all-requests.md) - The oas-web loopback Host check must run before every request, not just POSTs, because GET file-serving APIs such as /api/file and /api/diff can leak workspace files to a DNS-rebinding page.
* [lessons/instance-work-mode-not-path.md](lessons/instance-work-mode-not-path.md) - In panelData/control-pane instances, work carries the mode string (worktree/checkout/attached); derive the actual work tree as <home>/work before using it as a cwd or allowed file root.
* [lessons/untrusted-worktree-entries-lstat-before-reading.md](lessons/untrusted-worktree-entries-lstat-before-reading.md) - Desktop viewers must lstat untracked worktree entries before reading them: render symlinks as readlink text and skip FIFOs/devices so untrusted worktrees cannot leak files or hang the server.
* [lessons/sanitize-marked-markdown-before-innerhtml.md](lessons/sanitize-marked-markdown-before-innerhtml.md) - DOMPurify decides what untrusted markdown markup survives, but surviving anchors still need a post-sanitize pass that rewrites local file links and forces safe target/rel on external links before innerHTML.
* [lessons/git-rename-stats-nul-parsing.md](lessons/git-rename-stats-nul-parsing.md) - Diff viewers must parse git --numstat -z and --name-status -z output with explicit old-NUL-new rename fields instead of the human dir/{old => new} form.
* [lessons/pin-node-test-globs-in-nested-worktrees.md](lessons/pin-node-test-globs-in-nested-worktrees.md) - In OAS repos where agent instance homes contain nested work checkouts, bare node --test can recurse into stale sibling suites, so npm test must pin intended globs and destructive helpers must default to sandbox targets.

## playbooks/

* [playbooks/dev-loop-and-marketplace-refresh.md](playbooks/dev-loop-and-marketplace-refresh.md) - version bumps on every behavior change and the rm-installed-copy + lock-entry + reinstall refresh dance.

## references/

* [references/web-pane-decision.md](references/web-pane-decision.md) - pointer to the founding Decision (oas-expert soul): terminal-direct not aweb, localhost-only, zero dependencies.
