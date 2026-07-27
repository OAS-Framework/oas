---
name: accessible-desktop-interactions
description: >-
  Use when designing, implementing, or reviewing OAS desktop interactions that
  involve tabbed artifact surfaces, asynchronous modal mutations, native
  directory pickers, roving listbox/radio selection, focus restoration, or
  cases where disabled actions could strand keyboard focus behind a modal.
---

# Accessible desktop interaction patterns

Use native semantics, deterministic focus restoration, and explicit focus
parking so asynchronous desktop UI remains keyboard-operable while state changes
are in flight.

## Semantic tabs

- Use a `tablist` containing semantic tab triggers with `aria-selected` and `aria-controls`.
- Pair each trigger with a named `tabpanel`.
- Support Arrow keys, Home, End, Delete, and platform close shortcuts.
- Use native close buttons.
- When a tab closes, restore focus to a deterministic neighbor; when the final artifact tab closes, restore focus to the originating stage.

## Modal mutation focus parking

A non-dismissible asynchronous mutation may disable every action, but it must not
leave the dialog without a focus target.

- Provide an internal programmatic target, such as a live status with `tabindex="-1"`.
- Move focus to that target while busy.
- Trap Tab on the parked target until actions are re-enabled.
- Restore the initiating action after recoverable failure.
- Restore the original trigger after success or cancellation.

## Roving selection

For custom radio/listbox behavior:

- Expose one tab stop.
- Implement Arrow, Home, and End movement.
- If filtering hides the selected item, clear the selection and disable confirmation so a hidden choice cannot be submitted.

## Gotchas

- Disabled buttons are not a focus strategy; if every action is disabled, park focus inside the dialog.
- Test keyboard paths and synthetic handler entry points, not only pointer clicks on enabled buttons.
- Filtering must invalidate hidden selections before submission.
