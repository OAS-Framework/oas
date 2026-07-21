---
type: Concept
title: Model preference lists probe pi's catalog and fall back to the first entry
description: A soul's model field is a comma-separated preference list of provider/id[:thinking] patterns; resolveModelPreference picks the first entry actually available by probing pi --list-models, and any probe failure or non-pi runtime falls back to the first entry so pi errors loudly at launch.
tags: [model, runtime, resolveModelPreference, spawn, pi]
timestamp: 2026-07-21
---

# Behavior (lib/core.mjs resolveModelPreference)

- `model` (soul.yaml or `--model`) may be a comma-separated LIST:
  `"anthropic/claude-x:high, openai/gpt-y"`.
- Single entry (or empty): returned as-is, no probe.
- Multiple entries, runtime `pi`: for each preference, strip the `:<thinking>`
  suffix, split `provider/id`, and probe `pi --list-models <id>`; the first
  entry whose provider+id appears in the catalog output (authenticated
  providers only) wins.
- Bare pattern without a provider: returned immediately — let pi resolve it.
- Non-pi runtimes or probe failures: **first entry wins**. Deliberate: the
  kernel does not silently pick something else; pi errors loudly at launch if
  the model is unavailable.

# Notes for changes

- The probe shells out per preference — keep lists short and don't call this
  in loops.
- The `:thinking` suffix is part of the preference and is preserved on the
  returned value; only the catalog probe strips it.
- Tests fake the runtime binary (see `fakeRuntimes` in
  test/capabilities.test.mjs) — a fake `pi` that exits 0 with no output makes
  every probe miss, exercising the first-entry fallback.
