---
type: Lesson
title: Reconciling split panes with quick-open focusContent semantics
description: Merging PR #40's focusContent/terminal.focusActive into the split-panels branch was purely additive because split pane selection and close-successor activation deliberately call activateTab without focusContent, matching main's user-jump-only focus rule.
tags: [desktop, splits, merge, keybindings]
timestamp: 2026-07-26
---

# Reconciling split panes with quick-open focusContent semantics

feature/split-panels was cut before PR #40 (Quick Open) landed on main, so the branch had to merge origin/main to avoid removing shipped features in the eventual PR diff. All conflicts were additive unions except one semantic check: main's `activateTab(id, { focusContent })` distinguishes user-initiated jumps (focus the xterm textarea) from side-effect activations (must not steal focus). The split code already conformed:

- `wireSplitPaneSelection` select → `activateTab(id)` (no focusContent): the user clicked INTO the terminal, xterm handles its own focus — forcing focusContent would be redundant and re-entrant.
- `splitSuccessor` activation on close → also no focusContent (side-effect).
- `terminal.focusActive` composes fine with splits: the active tab under a visible split is the member the user last selected (pane-selection wiring keeps that true).

Merge craft reminder: when both sides add adjacent entries to the same list (palette commands, registerAction blocks, DEFAULT_KEYMAP, allowlist comments), resolve by unioning both sides in a stable order; soul-knowledge log.md conflicts are always union (append-only history).

# Related concepts

- [Split panes as flex-cell reprojection of existing tab panes](/lessons/split-panes-flex-reprojection.md)
- [Terminal focus follows user intent through activateTab's focusContent option](/decisions/terminal-focus-intent.md)
