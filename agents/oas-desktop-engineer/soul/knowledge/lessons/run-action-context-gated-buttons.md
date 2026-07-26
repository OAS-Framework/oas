---
type: Lesson
title: Mouse affordances dispatch registered actions through a context-gated runAction
description: Desktop shell buttons that duplicate chord functionality should call an engine-level runAction(id) that applies the same context gating as chord dispatch, and derive enabled state by dry-running the same pure model transition the action performs.
tags: [desktop, keybindings, splits, ui]
timestamp: 2026-07-26
---

# Mouse affordances dispatch registered actions through a context-gated runAction

Desktop shell buttons that duplicate keybinding functionality should run the
same registered actions as their chords, not exported copies of the shell's
private functions. The split/sidebar buttons use a tiny engine surface for that:
`keybindings.mjs` exposes `runAction(id)`, looks up the registered action,
applies the same `contextEligible` gate as chord dispatch, runs it, and returns
whether it ran.

That keeps mouse affordances from bypassing keyboard context rules. For example,
split buttons stay inert while a stage covers the tab layer because the action's
context is ineligible; no button-side conditional re-encodes that policy.

# Enablement without policy drift

Button enabled state should come from the same pure model transition the action
will perform. `split-controls.mjs` computes `splitControlsState` by dry-running
`requestSplit(split, orientation, activeId)` and rendering the returned `changed`
value as enabled or disabled. When split gating changes, such as capability
checks or pending-slot rules, buttons follow the model automatically.

# Tooltip wiring

Buttons carry `data-action="<id>"`, so the shell's existing `applyChordTitles`
keymap subscription can suffix the live chord onto button tooltips. Do not add a
parallel per-button `onKeymapChange` path for the same data.

# Related concepts

- [Key dispatch engines own consumed-event and editable-field guards](/lessons/keybinding-dispatch-guards-in-engine.md)
- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [Split panes as flex-cell reprojection of existing tab panes](/lessons/split-panes-flex-reprojection.md)
