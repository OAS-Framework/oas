---
type: Lesson
title: Polling innerHTML repaints destroy text selection
description: Background poll renders that replace a transcript's innerHTML collapse in-progress selections; defer those repaint frames while a non-collapsed selection is anchored inside the surface, and clear the render signature so the skipped frame retries later.
tags: [desktop-renderer, chat, selection, copy, polling]
timestamp: 2026-07-25
---

# Polling innerHTML repaints destroy text selection

The desktop chat transcript could not be copied even with `user-select: text`:
`renderChat` repainted via `box.innerHTML = html` on a 1.5s poll (400ms in
fast mode), and every repaint destroyed the user's in-progress mouse selection
before they could press Cmd+C.

# Fix pattern

Before a background repaint (`scroll === false`), check whether the browser
selection blocks repaint of the chat box:

- `window.getSelection()` exists;
- the selection is non-collapsed;
- it has a range; and
- the range's `commonAncestorContainer` is inside the box.

If so, skip the paint and clear the render signature (for example,
`lastChatSig = ""`) so the skipped update retries on a later tick once the user
copies or clicks away. User-initiated renders such as selection switches or
`scroll === true` still paint.

This is the transcript-copy sibling of [the open-form repaint barrier](/lessons/poll-repaint-wipes-form-input.md):
forms protect DOM-held typed input; selected transcript text protects DOM-held
browser selection state. The modal-focus sibling is [modal innerHTML rerenders
must restore focus by stable key](/lessons/modal-rerender-focus-restoration.md):
there the destroyed browser state is `document.activeElement`, and losing it can
break the dialog containment contract.

# Related desktop copy plumbing

Both of these are needed for copy to work at all in the Electron app:

- an application menu with the `editMenu` role, because without it Cmd+C/V/X/A
  are dead in the renderer on macOS; and
- a `context-menu` webContents handler offering Copy for selected text, gated on
  `params.editFlags`.
