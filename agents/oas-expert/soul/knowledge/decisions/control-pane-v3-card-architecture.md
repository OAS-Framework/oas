---
type: Decision
title: Control Pane v3 card architecture
description: The Control Pane v3 redesign replaces the list+inspector split with a single identity-rail card stack, in-place expansion, variable-height scrolling, and full-screen zoom.
tags: [control-pane, design, tui]
---

# Context

A second feedback round asked for a first-principles rethink of Control Pane as
"the best dashboard TUI in existence." The prior two-panel list+inspector layout
had begun to duplicate information: name, branch, and next action appeared in
both the list and the inspector, while roughly a third of the width was spent on
whichever panel was not the user's current focus.

This follows the earlier [Control Pane visual language](/decisions/control-pane-visual-language.md)
work, but changes the primary structure.

# Decision

Control Pane v3 is a single full-width stack of agent cards rather than a
separate list and inspector.

- **Identity rail**: each card's left edge is a 2-cell block in the soul's color
  from the hashed palette, dimmed to the background when idle. This replaces the
  badge pill in the list; color-as-structure reads faster than color-as-label,
  and the rail frames the expanded content. The badge pill survives in zoom
  mode's title.
- **In-place expansion**: the selected card grows to include either the live tmux
  capture or the details fields inside the card. There is one visual object per
  agent, and focus follows selection.
- **Zoom mode**: pressing `space` opens a full-screen live view of one agent with
  its next action in the footer; `esc` returns to the card stack.
- **Variable-height scrolling**: cards are built first, then scrolled by their
  real heights using a `used(from,to)` loop so the selected expanded card is
  always fully visible.
- **Quiet factual header**: the left side reads `⌁ OAS · workspace`; the right
  side reads `● running · ○ idle · ⌥ workstreams · △ unlinked`.

"Workstreams" means distinct non-main branches, answering what feature work is
in flight at a glance.

# Consequences

Future Control Pane UI work should treat the card stack, identity rail,
in-place expansion, and zoom as the v3 baseline unless later user feedback or
terminal constraints justify a new design decision.
