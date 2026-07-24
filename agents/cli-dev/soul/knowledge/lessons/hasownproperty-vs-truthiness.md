---
type: Lesson
title: Truthiness lookups misclassify declared-but-falsy manifest entries
description: Checking `!obj[key]` to detect an unknown key conflates absent with declared-but-falsy manifest entries; test key existence first, then validate the value with its own error code.
tags: [cli, validation, error-codes, javascript]
timestamp: 2026-07-24
---

# Lesson

A dispatcher guard such as `if (!sub || !m.commands[sub])` treats a declared
manifest entry like `commands: { ping: "" }` as unknown command `ping`. That
creates a contradictory diagnostic when the command is still listed as
available, and it bypasses the non-empty-string validator that should report
`E_CAPABILITY_BROKEN`.

Keep existence and validity as separate questions with separate error codes:

- test existence with `Object.prototype.hasOwnProperty.call(obj, key)`, not
  truthiness;
- avoid `in` when prototype pollution is part of the threat model;
- after existence is established, validate the value and emit the value-specific
  error code.

Regressions should sweep the falsy/non-string set that matters for manifest
command values, including `42`, `""`, `0`, `false`, and `null`, and also assert
that a genuinely absent key keeps the unknown-command code.

When a test intentionally accepts "either code", ask whether the implementation
actually commits to one. If the classification is deliberate, assert the exact
code so regressions cannot hide in the disjunction.
