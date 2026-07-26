# oas desktop — renderer views (webpanel-dev)

Ports of the retired browser panel's functionality as desktop renderer views,
per the desktop-app contract: each view is a plain ES module exporting
`mount(el, ctx)` / `unmount()`, where `ctx = { api(pathname, opts),
openFile(path), openTerminal(instance) }` is provided by the shell.
No frameworks, no dependencies; data comes from the bundled backend HTTP API.

## Views (`views/`)

- **spawn.mjs** — available agents (`GET /api/agents`) with spawn-from-app
  (`POST /api/spawn`), purpose/task fields. Panel defaults hold: empty task
  spawns an instance awaiting instructions; attached-mode agents are not
  spawnable standalone. Without a compatible installed `oas` CLI the view
  shows the shared degradation card and disables Spawn consistently.
- **cli-status.mjs** — shared CLI degradation state + the ONE card
  (detected path/version, required range, **Choose oas…**, **Retry**, docs
  link, copyable install command). Views subscribe via `onCliChange`;
  re-probe triggers: launch, app focus, Retry, choose (contract).
- **common.mjs** — shared helpers: escaping, mini-markdown, ctx.api JSON
  wrappers, roster grouping, and workspace switching (`?ws=`) — the selected
  workspace is shared across views via `setWorkspace`/`onWorkspaceChange`
  (persisted in localStorage), so a shell-level switcher can drive it too.

`theme.css` carries the panel's semantic design tokens (dark + solarised
light, WCAG AA); views style themselves against tokens only, scoped under
`.oas-view` so shell chrome is unaffected.

## Keybindings (shell-level)

- **keybindings.mjs** — the keymap engine: action registry
  (`registerAction`/`setActiveContexts`; a registration may carry a
  `defaultChord` that folds into the effective keymap like a
  `DEFAULT_KEYMAP` entry — override wins, explicit unbind kills it),
  `DEFAULT_KEYMAP`, user overrides
  persisted under `localStorage["oas-desktop-keymap"]`, chord
  parse/format/match, and dispatch (`matchEvent`/`handleKeydown`). The engine
  skips already-consumed (`defaultPrevented`) events, and unmodified/
  shift-only chords never fire while an editable field (input, textarea,
  select, contenteditable) has focus. Terminal
  policy: inside `.xterm`, on macOS only ⌘-resolved chords fire; on
  Linux/Windows only `TERMINAL_ALLOWLIST` action ids (palette, tab
  next/prev/close) may fire — all other Ctrl chords belong to the attached
  program. `app.quickOpenSouls` (Mod+P) is deliberately NOT allowlisted:
  ⌘P fires inside xterm on macOS via the ⌘-chord policy, but Ctrl+P inside
  xterm on Linux/Windows is the shell's history navigation and reaches the
  pty.
- **overlay-picker.mjs** — the shared overlay + fuzzy machinery behind the
  command palette and Quick Open: one input over a listbox
  (arrows/Enter/Esc, aria option pattern), the house subsequence scorer
  (`subsequenceScore`; `null` = no match — prefix bonuses make real scores
  negative), and the stale-load generation guard.
- **quick-open.mjs** — Quick Open for souls (`Mod+P`, also “Souls: quick
  open…” in the palette): fuzzy-find a soul from the Spawn view's data
  source and hand off to the Spawn view's own form flow —
  `views/spawn.mjs` `preselectSoul()` opens the spawn modal for a
  spawnable soul on a verified CLI, and otherwise (attached-only, CLI
  pending/unavailable) focuses the soul's card so the existing degradation
  UI explains the state. No second spawn form exists.
- **keybindings-editor.mjs** — the shortcuts editor dialog (`Mod+,`):
  actions grouped by context, click-to-record (Esc cancels, Backspace
  unbinds), conflict warnings via `findConflict`, per-row reset + reset-all.

## Split panes and the hideable sidebar (shell-level)

Splits reproject existing TERMINAL tabs as flex cells of `#tabhost`
(`split-layout.mjs` is the pure model; `split-dom.mjs` the DOM projection).
A split always seeds from the CURRENT tab — `requestSplit` puts the active
terminal tab in `members[0]`, so the tab you split from stays the first,
visible, active pane; the pending slot absorbs the next terminal you open.
Clickable controls mirror the chords with no duplicated logic: the tab-strip
buttons (`#tab-actions`: split right / split down / close split) and the
sidebar toggles (rail-footer button + the thin `#sidebar-restore` edge
button shown while hidden) all dispatch the registered actions through
`runAction(id)` — context-gated exactly like chord dispatch — and their
enablement dry-runs the same model transition via
`split-controls.mjs` `splitControlsState`. While a split is visible the tab
strip is grouped to match it (editor-group style, `projectTabStrip`): each
member's real tab element moves into a `.tab-group` sized like its pane in
pane order (row: groups share the strip width as the panes share the host;
col: group order left→right = pane order top→bottom), a pending slot keeps
an empty spacer group, and non-member tabs keep their flat look in a
trailing group. One chrome per tab means the tab-a11y roving/aria/close
semantics are untouched; the non-split strip renders exactly as before.

## Terminal focus discipline (shell-level)

Jumping to an instance terminal (palette instance row, sidebar roster row,
post-spawn open) ends with the xterm textarea focused — on the fresh-open
path (`term.focus()` inside the terminal tab's `onReady`) AND on the
already-open activation path: `activateTab(id, { focusContent: true })`
invokes the tab's `focusContent` callback (a terminal tab's is
`term.focus()`). `focusContent` defaults to `false`, so side-effect
activations — workspace-switch restoration, close-fallback — never steal
focus; only user-initiated jumps pass it. `terminal.focusActive` is a
rebindable, editor-visible global action that focuses the active terminal's
input from anywhere; it ships with NO default chord (Ctrl chords belong to
the pty on Linux/Windows and plain keys are guarded off editables — bind
one in the shortcuts editor if wanted).

## Developing without the shell

`harness.html` supplies a stub `ctx` and tab chrome for ALL views — including
the Markdown tab (it prompts for a file path;
`ctx.openFile` routes into the markdown view); `harness-server.mjs`
serves it and proxies `/api/*` to a running backend server (same-origin, so
GETs and guarded POSTs both work exactly as in the real shell):

```sh
node packages/desktop/server/oas-web.mjs start --port 4821 --dir <workspace>
node packages/desktop/renderer/harness-server.mjs --port 4899 --api http://127.0.0.1:4821
open "http://127.0.0.1:4899/"
```
