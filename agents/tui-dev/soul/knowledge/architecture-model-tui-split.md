---
type: Concept
title: Control Pane architecture — model/TUI split and shared data layer
description: The Control Pane is split into a runtime-neutral data model (lib/control-pane/model.mjs) and an ANSI terminal frontend (lib/control-pane/tui.mjs), and the model is shared with the oas.web browser panel, so model changes must be coordinated with both consumers.
tags: [control-pane, architecture, model, oas.web]
timestamp: 2026-07-20
---

`oas pane` is built from two files with a deliberate boundary:

- **`lib/control-pane/model.mjs`** — gathers plain current-state objects with
  no rendering concerns: `listInstances()` for instance homes, `tmux
  list-windows` for liveness, `git status --short --branch` + `git diff
  --numstat` per work tree, `TASK.md`/`STATE.md` section extraction
  (`readMarkdownSection`), and a recursive knowledge-concept count. The entry
  point is `collectControlPane(root)`, which returns a snapshot: `instances`,
  constellation `rows`, `running`, `soulCount`, `tmuxAvailable`,
  `generatedAt`.
- **`lib/control-pane/tui.mjs`** — owns all ANSI rendering and raw-mode input.
  It has no pi API dependency; the pane is a standalone CLI feature so it
  works identically for pi and Claude Code instances (tmux is the
  runtime-agnostic seam).

**Critical**: `model.mjs` is NOT private to the TUI. The **oas.web** browser
panel (`oas web`, the oas.web marketplace capability) reuses
`collectControlPane` as its data layer, iterating multiple agents roots and
serializing the same instance objects to JSON. Any change to the snapshot
shape — renamed fields, new required inputs, changed `tmux`/`git` sub-objects
— must be checked against the web panel's consumption, not just the TUI.

External process calls all go through a single `exec()` wrapper with a 2.5s
timeout that returns `""` on any failure — the pane must degrade gracefully
(e.g. `tmuxAvailable: false` → "file state only" footer) rather than crash
when tmux or git is absent.
