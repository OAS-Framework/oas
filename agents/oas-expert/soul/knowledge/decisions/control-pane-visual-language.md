---
type: Decision
title: Control Pane visual language
description: Design decisions from the Control Pane redesign: soul badges, branch chips, tree glyphs, three-line rows, and the feedback that drove them.
status: superseded
tags: [control-pane, design, tui]
timestamp: 2026-07-24
---

# Supersession

The [desktop panel succession decision](/decisions/desktop-panel-succession.md)
supersedes this TUI language as the continuing product baseline. The concept
remains a historical design and migration source.

# Context

User feedback on the first Control Pane design said it was not sleek, the
agent type was unreadable, and the spawn tree and branch were not visual
enough.

# Decision

The July 2026 Control Pane redesign in `lib/control-pane/tui.mjs` uses this
visual language:

- **Soul badge**: render the agent type as a filled pill with a colored
  background hashed from the soul name into a six-color palette and near-black
  bold text. The same soul always gets the same color, and the badge repeats in
  the detail header.
- **Branch chip**: render feature branches — anything except `main` or
  `master` — as violet-filled chips such as `` feat/x ``. Render `main` faintly
  so feature branches pop. Show churn (`+N -N`) only when nonzero.
- **Tree**: use rounded/arrow guides (`├─▸`, `╰─▸`, `│`) in a dedicated guide
  color so lineage reads as a literal tree, including continuation through the
  NOW line and blank gap row.
- **Rows**: use three lines per instance row — title, `→ next-action`, and a
  spacer carrying the tree spine — because the breathing room makes the view
  feel clean.
- **Selection**: use a cyan left edge bar `▌` and a slightly lighter row
  background instead of a `›` caret.
- **Case discipline**: keep role labels lowercase and faint (`driver`, `root`,
  `unlinked`); reserve bold emphasis for the soul badge and instance name.

# Consequences

This decision records the first Control Pane redesign vocabulary. The later
[Control Pane v3 card architecture](/decisions/control-pane-v3-card-architecture.md)
supersedes the list badge and two-panel implications with identity rails,
in-place expansion, variable-height scrolling, and zoom. For fast layout
iteration, use the [mock render playbook](/playbooks/control-pane-mock-render-iteration.md).
For light/dark terminal handling, use the [terminal theme inference lesson](/lessons/tui-theme-inference.md).
