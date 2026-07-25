---
type: Lesson
title: Renderer entry modules can ship unparseable behind a green suite
description: Electron-only renderer entry modules are not imported by the unit suite, so run node --check over renderer/*.mjs to catch syntax breaks that all ordinary tests can miss.
tags: [desktop, tests, tooling]
timestamp: 2026-07-25
---

# Lesson

The desktop unit suite imports pure modules but does not load Electron-only entry
modules such as `renderer/shell.mjs`. A botched edit deleted the
`function showTerminalContext() {` declaration and left stray `};──` tokens; all
203 unit tests still passed, while `node --check renderer/shell.mjs` failed and
the app could not boot.

# Guardrail

Keep a renderer-wide syntax smoke test. `test/renderer-syntax.test.mjs` runs
`node --check` over `renderer/*.mjs` while excluding vendor files, so entry module
parse errors fail without launching Electron. After a multi-edit session that
changes renderer entry modules, also run the cheap targeted check, for example
`node --check renderer/shell.mjs`.

# Related concepts

- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
- [Shell nav reachability needs an importable manifest](/lessons/shell-nav-reachability-manifest.md)
