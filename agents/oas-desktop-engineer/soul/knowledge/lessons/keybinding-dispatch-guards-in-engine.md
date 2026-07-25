---
type: Lesson
title: Key dispatch engines own consumed-event and editable-field guards
description: A shared keybinding engine should internalize the e.defaultPrevented skip and the plain-key-vs-editable-field guard rather than relying on every caller to wrap dispatch; shift-only chords count as unmodified because typing produces shifted characters.
tags: [desktop, keybindings, dispatch, design]
timestamp: 2026-07-25
---

# Guards belong in the engine, not the caller

The keybindings engine initially relied on the shell to wrap dispatch with
`if (!e.defaultPrevented) handleKeydown(e)`. The contract addendum moved both
policies inside `matchEvent`:

- **defaultPrevented skip**: view-local handlers such as the hierarchy canvas,
  roster rows, and palette input preventDefault what they consume; if the
  engine does not check, every future caller must remember the wrap, making an
  eventual double-dispatch bug likely.
- **Editable-field guard**: a chord with no ctrl/alt/mod modifiers can be
  rebound to a plain key such as `b`, so it must not fire while an `INPUT`,
  `TEXTAREA`, `SELECT`, or contenteditable target has focus. Shift-only counts
  as unmodified because typing produces shifted characters. Modified chords
  still fire from editables, so `⌘K` in a filter box is valid.

This mirrors the older panel lesson: route keys logically and exclude only real
editable controls, using the same exclusion list.

# Test seam

`matchEvent(e, { editableTarget })` takes an explicit override for unit tests,
with the default derived from `e.target.tagName` and `isContentEditable`. Plain
object targets such as `{ tagName: "INPUT" }` suffice, so the tests do not need
JSDOM.

When a source-pinning wiring test asserts the exact shell listener line, moving
a guard into the engine requires updating that pinned regex in the same commit.

# Related concepts

- [Route panel keyboard by logical pane focus, not DOM focus](/lessons/logical-key-routing-not-dom-focus.md)
- [Keybinding engine terminal allowlist is action-id based, not chord based](/lessons/keybindings-terminal-allowlist-by-action-id.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
