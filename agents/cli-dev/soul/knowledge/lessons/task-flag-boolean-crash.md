---
type: Lesson
title: flag() returns true when a flag's value is missing — --task crashed spawn
description: bin/oas.mjs flag() yields boolean true when the next argv token starts with "--"; oas spawn dev --task --purpose x passed task=true into spawnInstance and crashed mid-scaffold at task.trim(), while task delivery itself was never broken.
tags: [cli, bug, task-delivery, flags]
timestamp: 2026-07-24
---

# Lesson

Reproduction showed `--task` and `--task-file` both deliver correctly to
`TASK.md` in normal use (plain and env-polluted shells). The human-reported
"task not delivered" symptom matches the missing-value case: `--task`
immediately followed by another flag makes `flag()` return `true`, and
`spawnInstance` crashed with `task.trim is not a function` after creating the
home — leaving a broken half-scaffolded instance with no task.

Fix: `spawnCmd` dies early on `--task`/`--task-file` without values (and
missing task-file paths); `spawnInstance` validates `typeof o.task` before any
scaffolding. Any new value-carrying flag needs the same guard — `flag()` is
shared and its boolean fallback is a foot-gun.
