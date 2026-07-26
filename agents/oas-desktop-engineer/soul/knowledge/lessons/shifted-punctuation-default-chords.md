---
type: Lesson
title: Default chords with shifted punctuation must alias the shifted character
description: Browser KeyboardEvent.key reports the shifted character, so default chords such as Mod+Shift+Backslash need KEY_ALIASES coverage and event-level dispatch tests.
tags: [desktop, keybindings, defaults, testing]
timestamp: 2026-07-26
---

# Default chords with shifted punctuation must alias the shifted character

A default chord can parse and round-trip correctly while still never firing if
its event-time key normalization does not cover shifted punctuation. Review
8443068 caught this with `Mod+Shift+\`: pressing Shift+Backslash reports
`event.key === "|"`, but the stored chord key is `"\\"`, so `chordFromEvent`
did not match.

The engine's normalization layer (`KEY_ALIASES` in `keybindings.mjs`) already
handled `+` -> `=` for `Mod+=`; every new default that relies on shifted
punctuation needs the same event-key alias from shifted character to base key
(for example, `|` -> `\`).

Regression coverage must dispatch the actual shifted `KeyboardEvent.key` value.
Source pins and `parseChord` round-trips can pass while the browser dispatch path
is still dead.

# Related concepts

- [Dynamic action registrations carry their own default chords](/lessons/dynamic-action-registration-default-chords.md)
- [Real keybindings engine integration keeps defaults engine-owned](/lessons/real-keybindings-engine-integration.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
