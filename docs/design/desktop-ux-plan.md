# OAS Desktop — UX plan (phase 1)

Author: ux-designer-desktop-ux · Branch: `ux-designer/desktop-app`
Scope: design language + UX for `packages/desktop/` (Electron shell,
xterm.js terminal, brain viewer, markdown viewer, diff viewer, panel port).
This is a **decision document**: each section states the chosen option and why.
It is written against the binding contract in
`briefs/desktop-app-CONTRACT.md` (view modules `mount(el, ctx)` / `unmount()`;
data from the oas-web HTTP API; tmux-attach terminals).

---

## 1. Design research — what we take from VS Code and opencode

### VS Code shell anatomy (what applies)

VS Code's shell is: **activity bar → sidebar → editor group (tabs) → panel →
status bar**, all keyboard-addressable through a **command palette**, all
colored through **semantic theme tokens** (`editor.background`,
`sideBar.foreground`, …) rather than raw hex in components.

Principles we adopt:

1. **One persistent shell, swappable content.** Chrome (sidebar, tabs, status
   bar) never remounts; only the active view does. This maps 1:1 onto the
   `mount(el, ctx)` contract — the shell owns chrome, views own their `el`.
2. **Semantic color tokens.** Components reference roles (`--surface`,
   `--accent`, `--term-bg`), never palette values. Themes are token maps.
   The existing panel (`capabilities/oas-web/ui/panel.html`) already does
   this correctly — we extend its token set, we don't replace it (§4).
3. **Command palette as the universal escape hatch.** Every action reachable
   by mouse is reachable by `⌘K` (see §5). This is the cheapest way to be
   keyboard-first without designing a shortcut for everything.
4. **Tabs are documents; the sidebar is the world.** Tabs hold *open work*
   (a terminal, a diff, a markdown file); the sidebar holds *everything that
   exists* (the roster). Closing a tab never destroys the underlying thing —
   which matches the contract exactly (detach pty, never kill tmux).
5. **Status bar for ambient truth**: connection to the oas-web server,
   active workspace, running-instance count, theme toggle.

What we deliberately **do not** clone:

- **No activity bar.** VS Code's activity bar exists because it has many
  coequal top-level domains (explorer, SCM, debug, extensions). OAS desktop
  has *one* primary domain — agents — so a vertical icon rail would be
  ceremony. The sidebar gets a small segmented header instead
  (Agents | Hierarchy) — two modes, not five domains.
- **No multi-root editor-group splitting (phase 2).** The panel's proven
  ≤3-pane terminal split is enough initially; generalized grid splitting is
  a later enhancement, not a launch requirement.

### opencode (what applies)

opencode is a TUI-first agent client: session list on the left, one live
session dominating the screen, minimal chrome, everything driven by keys and
a fuzzy switcher. Principles we adopt:

1. **The session is the hero.** When you open an instance, its live terminal
   fills the stage immediately — no dashboard detour, no click-through.
2. **Fast session switching** (fuzzy, recency-ordered) matters more than
   deep navigation trees. Our palette's default mode is "jump to instance".
3. **State is legible at a glance**: running/idle/busy is shown as a colored
   dot next to every session name, everywhere the name appears (roster,
   tabs, hierarchy graph, palette). One vocabulary of status dots (§5).
4. **Terminal fidelity over widgetry.** Don't wrap the agent session in
   chat-bubble reconstructions; show the real terminal. The contract's
   direct tmux-attach already commits us to this — the UX embraces it.

---

## 2. Information architecture — agents at the heart

**Decision: the primary object is the agent *instance*.** Files, diffs,
terminals and brains are *facets of an instance*, not siblings of it. The IA
is instance-centric, not file-centric — this is the single biggest departure
from VS Code, and the reason the app exists.

### Shell layout

```
┌──────────────────────────────────────────────────────────────┐
│ titlebar: ● oas  [workspace ▾]        filter/⌘K      ◐ theme │
├───────────────┬──────────────────────────────────────────────┤
│ SIDEBAR       │ TAB STRIP  [dev-1 ⬤][dev-1: diff][README.md] │
│ ┌───────────┐ ├──────────────────────────────────────────────┤
│ │Agents|Tree│ │                                              │
│ └───────────┘ │            ACTIVE VIEW                       │
│ roster:       │   (terminal / brain / markdown / diff /      │
│  ws → repo →  │    hierarchy / home)                         │
│   instances   │                                              │
│  (children    │                                              │
│   indented)   │                                              │
│ ── souls ──   │                                              │
│  spawnable    │                                              │
├───────────────┴──────────────────────────────────────────────┤
│ status bar: ⬤ server · ws:oas · 4 running · branch · theme   │
└──────────────────────────────────────────────────────────────┘
```

- **Sidebar (left, collapsible ⌘B)** — the roster, ported from the panel:
  workspace → repo → instances, with spawn-children indented under parents
  (the panel's `parentInstance` walk is kept verbatim). Below it, spawnable
  souls with a Spawn action. A segmented control at the top switches the
  sidebar between **Agents** (list) and **Hierarchy** (mini-tree; the full
  graph opens as a view, §3).
- **Tab strip** — open facets. Tab title = `instance` (terminal),
  `instance: diff`, `instance: brain`, or file name (markdown). Terminal
  tabs carry the status dot. Middle-click / `⌘W` closes (detach only).
- **Status bar** — server reachability, workspace, running count. Clicking
  the server segment reveals host/port; clicking the count filters to
  running.

### The home surface

**Decision: home = the hierarchy view with an overview header**, not an
empty state and not a dashboard of widgets. On launch (no tabs open) the
stage shows the agent hierarchy graph (§3) topped by a one-line summary
("*oas workspace — 4 running, 2 idle, 1 retired today*") and a spawn button.
Rationale: it makes the app's thesis — *you are orchestrating a team* —
visible in the first second, and every node is one click from its terminal.

### Per-instance facet model

Selecting an instance (sidebar click, palette, or graph node) opens its
**terminal tab** — the hero facet. From the terminal tab's header (and the
context menu / palette) the sibling facets are one action away:

| Facet    | Source                        | Opens as              |
|----------|-------------------------------|-----------------------|
| Terminal | tmux attach via pty IPC       | tab (default)         |
| Brain    | `GET /api/brain/<agent>`      | tab `instance: brain` |
| Diff     | `GET /api/diff/<instance>`    | tab `instance: diff`  |
| Files    | `GET /api/file?path=…`        | tab per file (markdown viewer) |

Cross-facet links use the contract's `ctx` verbs: brain view lists skills /
knowledge / STATE.md → `ctx.openFile(path)`; any view can
`ctx.openTerminal(instance)`. The hierarchy view is itself a view module and
uses the same two verbs — no new contract surface needed.

**Decision: tabs are per-facet, not per-instance-with-inner-tabs.** Inner
tab bars (an instance tab containing terminal/brain/diff sub-tabs) were
considered and rejected: they double the chrome, break `⌘W`/`⌘1..9`
uniformity, and fight the `mount(el, ctx)` contract, which is flat. Facet
association is expressed by tab naming + grouping tabs of the same instance
adjacently.

---

## 3. Agent hierarchy visualization

**Decision: an interactive tree-of-trees (layered DAG), not a force-directed
graph.** Spawn parentage (`parentInstance` in the roster) is a forest —
force layouts add jitter and non-determinism for zero benefit on tree data.
Layout: **top-down tidy tree per workspace** (d3-hierarchy-style tidy layout;
implementable in ~150 lines without a dependency, or with `d3-hierarchy`
since desktop deps are allowed), workspaces side by side, SVG-rendered,
pan/zoom.

### Two relationship kinds, two visual languages

1. **Spawn parentage** (who spawned whom): solid edges, the tree structure
   itself. Source: roster `parentInstance`.
2. **Coordination** (who works with whom): dashed accent edges *overlaid*
   on the tree, shown on hover/selection (always-on is noisy). Source:
   shared workspace/repo membership + aweb team metadata as exposed by
   `/api/panel`; degrade gracefully if absent — the view must not depend on
   a new endpoint (if richer comms data is wanted later, that is a phase-2
   request to the coordinator, not an assumption).

### Node design

A compact card, not a bare circle — names and states must be readable
without hover:

```
┌──────────────────────────┐
│ ⬤ webpanel-dev-brain     │   ⬤ status dot (see states)
│ webpanel-dev · repo:oas  │   agent · repo, muted
└──────────────────────────┘
```

- **States** (same vocabulary app-wide): **running** = green dot +
  full-opacity card; **idle** = hollow/gray dot, card at ~65% opacity
  (matching the panel's `.inst.idle`); **retired** = dashed border,
  faint text, only shown when the "show retired" toggle is on (retired
  instances known from roster history if available; otherwise omitted).
- **Busy pulse** (phase-2 nice-to-have): subtle dot pulse when the session
  produced output in the last N seconds — cheap liveness signal.

### Interactions

- **Click node → focus + detail popover** (task line, branch, dirty chip,
  buttons: *Open terminal · Brain · Diff*). **Double-click / Enter → open
  terminal tab** directly.
- **Hover → highlight lineage** (ancestors + descendants) and show
  coordination edges for that node.
- Pan (drag), zoom (pinch/`⌘±`), `f` to fit. Keyboard: arrows walk the tree,
  Enter opens.
- Search-as-you-type filters/highlights nodes (reuses the sidebar filter
  semantics).

The hierarchy is both a **full view** (home surface / `⌘⇧H`) and a
**sidebar mini-mode** (same data, vertical indented tree — effectively the
roster's existing child-indentation, promoted).

---

## 4. Theming

**Decision: extend the panel's existing token system — it is already
semantic, already dual-theme, already AA-audited.** The panel's `:root` /
`[data-theme]` token blocks become `packages/desktop/renderer/theme.css`,
the single source of truth. Views consume tokens only; a view containing a
hex literal fails review.

### Token architecture

Three tiers, one file:

1. **Core surface/text/interactive tokens** (exist today): `--bg`,
   `--surface`, `--surface-2`, `--border`, `--fg`, `--muted`, `--faint`,
   `--accent`, `--accent-fg`, `--ok`, `--warn`, `--danger`, `--chip-*`,
   `--sel`, `--shadow`.
2. **Terminal tokens**: `--term-bg`, `--term-fg`, `--term-sel` (exist) plus
   a **16-slot ANSI set** `--ansi-black … --ansi-bright-white` (new —
   xterm.js takes a theme object; we generate it from these tokens so the
   embedded terminal matches the app theme, including the solarized remap
   the panel already ships for light mode).
3. **New component tokens** (thin aliases over tier 1, so themes rarely
   need to override them): `--tab-active-bg`, `--tab-inactive-fg`,
   `--statusbar-bg`, `--graph-edge`, `--graph-edge-coord`,
   `--diff-add-bg`, `--diff-del-bg`, `--md-code-bg`.

### Themes

- **Dark** (default when OS is dark): the panel's GitHub-dark-adjacent
  palette, unchanged.
- **Light**: the panel's **solarized-light** palette, unchanged —
  compatibility with the web panel is a requirement and the palette already
  passes AA (`--fg` 9.9:1, `--muted` 4.9:1 on surface).
- Theme = OS-follow by default, manual override persisted
  (`localStorage`, same keys as the panel: `oasweb.theme`) so panel and
  desktop feel like one product. Room for future themes = adding one
  `[data-theme="x"]` block; no component changes.

### Accessibility commitments (both themes, verified in phase 2)

- Body & secondary text ≥ 4.5:1 on their actual surfaces; UI glyphs/borders
  ≥ 3:1; status conveyed by **dot shape + label**, never color alone
  (idle = hollow dot, retired = dashed border — already specified in §3).
- Visible `:focus-visible` ring (`--accent`, 2px) on every interactive
  element; full keyboard reachability (tabs, sidebar, graph, palette).
- Diff colors get text labels (`+`/`−` gutters) in addition to
  `--diff-add/del-bg`; ANSI light remap keeps terminal output ≥ 4.5:1 as
  the panel already does.
- `prefers-reduced-motion`: disable graph pan-inertia, dot pulse, spinner
  fades.

---

## 5. Component inventory + interaction details

**Type & space.** UI font: system stack (as panel). Mono:
`"SF Mono", ui-monospace, Menlo` (as panel). Type scale (px):
11 (chips/status) · 12 (secondary) · 13 (body/controls) · 14 (view titles) —
matching the panel's proven density. Spacing scale: **4-px base**
(4/8/12/16/24/32); radii: 6 (small controls) / 8 (cards, inputs) / 999
(chips). Shadows: `--shadow` only.

**Components** (shell-owned unless noted):

- **Tabs**: 32px strip; active tab `--tab-active-bg` + 2px top accent
  (mirrors the panel's focused-pane inset accent); dirty/status dot on
  terminal tabs; overflow scrolls; drag-reorder phase-2. `⌘1..9` jump,
  `⌘W` close, `⌃Tab` MRU cycle.
- **Sidebar**: as panel roster (filter input, collapsible groups, chips for
  branch/dirty/runtime) + segmented Agents/Hierarchy header. `⌘B` toggle.
- **Command palette** (`⌘K`): single input, mode prefixes —
  default = jump to instance (fuzzy, MRU-boosted); `>` commands
  (spawn, toggle theme, open diff/brain of current instance, fit graph);
  `#` open file within current instance's home. Esc closes; results show
  status dots and repo chips.
- **Toasts**: bottom-right, `--surface` card + colored left border
  (`--ok/--warn/--danger`), auto-dismiss 5s (errors sticky with a Close
  button), max 3 stacked, `aria-live="polite"`. Used for: spawn result,
  server lost/regained, pty exit.
- **Loading states**: reuse panel's `.spinner` + `.loading-block`; skeleton
  rows (pulse animation) for roster and brain tree; terminals show
  "attaching to `<session>` …" with spinner until first pty bytes.
- **Empty states**: reuse panel's `.empty` pattern (big glyph, one sentence,
  one action). E.g. diff view with clean tree: "No changes on
  `<branch>` — the work tree is clean."
- **Dialogs**: only for destructive/parameterized actions (spawn with task
  text). Everything else is inline or palette.
- **Markdown viewer** (view module): panel typography, `--md-code-bg` code
  blocks with syntax highlight, heading anchor links, relative links to
  files resolved through `ctx.openFile`.
- **Diff viewer** (view module): file list (status/+/− counts) left or top,
  unified diff with `--diff-*` tokens, per-file collapse, staged toggle.
- **Brain viewer** (view module): two columns — soul (AGENTS.md, skills,
  knowledge tree) and instances (state/task/notes) — every leaf is an
  `openFile` link; skills show their descriptions inline.

**Keyboard-first rules**: `⌘K` palette · `⌘B` sidebar · `⌘T` spawn ·
`⌘⇧H` hierarchy · `⌘W`/`⌘1..9`/`⌃Tab` tabs · `⌘F` filter. **Ctrl-B is never
bound** — it is the tmux prefix and always flows to the focused terminal
(the panel already enforces this rule; we keep it as law).

---

## 6. Phase-2 implementation plan (incremental, contract-compatible)

Each step lands independently on the integrated app; none changes the view
contract or the API contract. Order chosen so every step is visible value.

1. **Token foundation** — extract/extend `renderer/theme.css` (tiers 1–3,
   ANSI variables), wire `data-theme` + OS-follow + persistence; generate
   the xterm.js theme object from tokens; contrast-check both themes
   (automated check script if feasible).
2. **Shell chrome polish** — tab strip (status dots, accents, keyboard
   map), status bar, sidebar restyle to spec (segmented header, chips,
   focus rings), toasts, loading/empty components as shared renderer
   helpers views can import.
3. **Command palette** — jump/command/file modes as above; registered
   commands provided by the shell; instance jump from roster data.
4. **Hierarchy view** — new view module `views/hierarchy.js` using only
   roster data + `ctx.openTerminal`/`ctx.openFile`; tidy-tree layout,
   node cards, states, lineage highlight, popover, keyboard nav; wire as
   home surface and `⌘⇧H`.
5. **View polish pass** — apply tokens/typography/empty-loading patterns to
   the four developer-built views (terminal header, brain, markdown, diff),
   coordinating any needed hooks through dev-coordinator-1.
6. **Accessibility + reduced-motion audit** — keyboard walk of every
   surface, focus-visible sweep, contrast verification, `prefers-reduced-
   motion` guards; fix list executed before calling phase 2 done.

### Addendum — human directives (received via coordinator before phase-2
go-ahead; to be re-confirmed in the go-ahead mail)

Binding design directives that supersede anything conflicting above:

1. **Diff viewer surface removed** — no nav entry, no diff tabs. `/api/diff`
   and `diff.mjs` stay in the tree, dormant; removing dead UI wiring is in my
   scope. (Step 5 no longer polishes a diff view; `--diff-*` tokens remain
   defined for a possible return.)
2. **Markdown reader is the flagship viewer** — `openFile → markdown` gets
   the depth budget: typography, highlighting, anchors, relative-link
   resolution via `ctx.openFile`, strong loading/empty states.
3. **Jira surface hidden entirely** — no nav entry or inline cards; code
   stays unwired. Verify no remnants during the polish pass.
4. **Three first-class surfaces**: (a) hierarchy view = home + primary
   navigation (extra investment beyond step 4); (b) a proper **souls
   browser** stage view (descriptions + spawn affordances, palette-reachable)
   — promoted from the sidebar-list sketch in §2; (c) a nice way into agent
   brains.
5. Everything else (themes, tokens, palette, a11y) stands as written.

Dependencies/risks flagged to the coordinator up front: (a) step 5 touches
other developers' view code — I will work on the *integrated* branch only,
after their merges; (b) coordination-edge data for §3 uses whatever
`/api/panel` already exposes — if we want explicit aweb-team edges, that is
a small additive API request, not a blocker.
