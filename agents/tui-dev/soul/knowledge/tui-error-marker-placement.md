---
type: Lesson
title: TUI session error surfacing — three surfaces, one field
description: Session errors in tui.mjs render from instance.sessionTail on the card title, expanded card, and zoom view, with layout adjusted so the extra error line does not overflow.
tags: [control-pane, tui, rendering, errors]
timestamp: 2026-07-21
---

Session errors are driven by the shared model field
`instance.sessionTail.state === "error"` and render in three places in
`lib/control-pane/tui.mjs`:

1. **Card title line** — a compact `✗ err` marker in `C.red + C.bold` appears
   immediately after the instance name. The same marker must be preserved in
   the narrow-width fallback branch of `buildCard`.
2. **Expanded card** — in live/preview mode, a red
   `✗ session error: <message>` line appears directly under the `┈┈ live ┈┈`
   header; in details mode, an `error` field appears before `context` and is
   capped at three wrapped lines.
3. **Zoom view** — the error line is pinned under the zoom header. Body height
   must be computed from `height - 2 - output.length` so the added line does not
   overflow the frame.

Palette discipline applies to error surfacing too: use semantic `C.*` theme
colors only, never raw `38;2` / `48;2` literals. See
[Hardcoded SGR color literals outside the palette break light mode](palette-discipline-lesson.md)
for the rule and the grep audit.
