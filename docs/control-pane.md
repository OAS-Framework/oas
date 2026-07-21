# Control Pane

**Control Pane** is OAS's live, read-only terminal view of the agent team. Open
it from a workspace or instance home:

```bash
oas pane
```

It shows the current instance constellation, live tmux state, worktree/branch
status, task and next action, a pane preview, and each soul's knowledge count.
It does not keep retired history or reconstruct past relationships.

The pane ships **two named themes**: `dark` (default) and `solarized`
(Solarized Light). There is no terminal detection or guessing — pick the
theme explicitly:

```bash
oas pane --theme solarized       # one-off
export OAS_PANE_THEME=solarized  # your default (--theme still wins)
```

## Navigation

| Key | Action |
|---|---|
| `↑` / `↓`, `j` / `k` | Select an instance |
| `g` / `G` | Jump to first / last |
| `Page Up` / `Page Down` | Move by a page |
| `Enter` | Switch directly to the selected running tmux window |
| `t` (`p` also works) | Toggle the native-color session preview and selected-agent details |
| `r` | Refresh immediately |
| `q` / `Ctrl-C` | Close Control Pane |

Mouse selection and wheel navigation are enabled in terminals that support
SGR mouse events. On wide terminals the live hierarchy is the primary view and
uses roughly two-thirds of the screen. The Agent Map uses a strict semantic
palette: green is live, violet is always branch identity, green/red are added/
deleted lines, cyan marks the current action or a driver, and amber is reserved
for incomplete data. Each node leads with its spawn purpose, keeps its soul,
role, age, branch, and diff on one line, and gives `NOW` its own action line.
The selected agent's session preview updates automatically in the remaining
column. The layout stacks as the
terminal narrows.

## Data and compatibility

Control Pane is a standalone CLI feature, not a pi extension. Its data model
uses OAS metadata and files plus ordinary `git` and `tmux` commands; the ANSI
terminal frontend is isolated from that model. It therefore works regardless
of whether an instance uses pi or Claude Code.

The view is deliberately live-only:

- Existing instance homes come from `listInstances()`.
- tmux window formats determine whether an instance is running and where
  `Enter` switches.
- `instance.json` supplies identity, runtime, work mode, and forward-only
  `parentInstance` spawn topology. Older instances without that field appear
  as roots.
- Git status comes from each instance's `work/`; task and progress come from
  `TASK.md` and `STATE.md`; knowledge depth is the current markdown concept
  count under the soul's `knowledge/`.
- `capture-pane` is used only for the selected running instance's preview; its
  native SGR colors are preserved while non-display control sequences are
  filtered.

The Agent Map and detail panel both expose lineage. Instances created before
parent metadata was introduced are labeled `UNLINKED` and contribute to the
header's `lineage unknown` count; newly spawned operator roots are `ROOT`, live
parents are `DRIVER`, and children nest beneath them. OAS deliberately does not
guess old relationships from names or task prose.

No retired records, event journal, ghost nodes, or relationship inference are
created. Runtime telemetry (token/cost activity, model events, tool activity,
and durable status transitions) is a follow-up: it needs a runtime-neutral
event contract shared by future adapters rather than pi-specific inspection
inside this UI.
