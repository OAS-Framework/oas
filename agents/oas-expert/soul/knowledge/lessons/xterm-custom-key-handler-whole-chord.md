---
type: Lesson
title: xterm custom key overrides must classify the whole physical chord
description: xterm invokes a custom key event handler across keydown, keypress, and keyup, so a modifier override must suppress every relevant phase while emitting its replacement byte exactly once.
tags: [desktop, xterm, keyboard, regression-testing]
timestamp: 2026-07-25
---

# xterm custom key overrides must classify the whole physical chord

In xterm 5.5, `attachCustomKeyEventHandler` is consulted from the terminal's
keydown, keypress, and keyup paths. Suppressing only a modified keydown can
leave the browser's keypress path enabled, allowing xterm to emit its default
byte after an application-written replacement byte.

A safe override separates two decisions:

1. whether every event belonging to the chord is suppressed; and
2. whether this particular phase emits the replacement byte.

For a Shift+Enter-to-newline override, keydown writes the replacement newline
once and returns false, while keypress and keyup write nothing and still return
false. Tests should drive the handler through the complete event sequence and
assert both return values and the exact one-write transcript; testing only a
pure keydown classifier does not cover the failure layer.

# Citations

1. Observed in the shipped `@xterm/xterm` 5.5 source,
   `src/browser/Terminal.ts`, while reviewing OAS PR #33 on 2026-07-25.
