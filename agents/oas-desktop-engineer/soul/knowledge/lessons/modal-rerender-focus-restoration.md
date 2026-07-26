---
type: Lesson
title: Modal innerHTML rerenders must restore focus by stable key
description: A dialog that rebuilds rows with innerHTML can eject document.activeElement to body, letting the next Tab escape an overlay-attached focus trap; capture the focused row control by stable key before rebuilding, refocus the replacement node, and fall back inside the dialog.
tags: [desktop, a11y, modal, focus, rerender, review]
timestamp: 2026-07-25
---

# Modal innerHTML rerenders must restore focus by stable key

The shortcuts editor's `render()` cleared `body.innerHTML` on every keymap
change. Any keyboard-triggered mutation, including record, Backspace-unbind, or
per-row reset, removed the focused button so `document.activeElement` fell to
`<body>`.

The Tab trap was attached to the overlay element only. With focus on `<body>`,
the next Tab started outside the overlay and reached controls behind the modal.
`aria-modal="true"` plus an overlay-scoped trap is not containment when a
rerender can eject focus.

# Fix pattern

1. Give every focusable row control a stable key, such as `data-action-id` plus
   a control-kind class.
2. Before the rebuild, capture `{ id, kind }` for `document.activeElement` only
   when it lives inside the dialog.
3. After the rebuild, focus the replacement node by key. If the exact control
   legitimately vanished, such as a per-row reset button hidden because the row
   is back at default, fall back to a sibling control on the same row.
4. Keep a final fallback to a fixed dialog control, such as the close button, so
   focus can never land outside the overlay.
5. Regression-test every mutation path that rebuilds the dialog, including
   record, unbind, reset, and reset-all. Assert both
   `dialog.contains(document.activeElement)` and that the subsequent Tab stays
   trapped.

# Related concepts

This is the modal-focus version of the innerHTML repaint lessons: DOM rebuilds
can destroy browser-owned text [selection](/lessons/polling-innerhtml-repaints-destroy-selection.md)
and DOM-held [form input](/lessons/poll-repaint-wipes-form-input.md). In a
modal, the browser-owned state is focus, and losing it breaks the containment
contract rather than only user convenience.

For the same shortcuts editor dialog, [dialog recorder teardown](/lessons/dialog-recorder-teardown-and-override-sanitization.md)
covers the document-level capture-listener cleanup and the baseline Tab wrap;
this lesson covers restoring focus after a row rerender inside that modal.
