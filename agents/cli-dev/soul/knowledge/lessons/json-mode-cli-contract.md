---
type: Lesson
title: JSON-mode CLI contracts need envelope and stderr progress discipline
description: When a CLI command grows a machine-readable --json mode for an external consumer, success and failure must be one stdout JSON envelope with stable error codes, and all human progress prose must move to stderr in JSON mode.
tags: [cli, json, contract, desktop]
timestamp: 2026-07-24
---

# Lesson

Adding `--json` to `oas spawn` for the Desktop CLI API v1 was not just wrapping
the result in JSON: every failure path (`die()`) and every progress line
(`console.log` for capability-agent or cross-repo notes) on the command's path
can contaminate stdout.

The pattern that worked in `bin/oas.mjs`:

- module-level `JSON_MODE = args.includes("--json")`, `jsonOk(result)`, and
  `jsonFail(code, message)` with exit 1;
- per-command helpers where `bail(code, msg)` chooses `jsonFail` or `die`, and
  `note(msg)` writes to stderr in JSON mode and stdout otherwise;
- a try/catch around the kernel call mapping exceptions to a stable code such
  as `E_SPAWN_FAILED`, plus a dispatch-level catch as a backstop;
- tests that parse `JSON.parse(r.stdout)` directly, so stdout contamination
  throws, and assert `stdout.trim() === JSON.stringify(doc)`.

Error codes are part of the published contract. Enumerate them in docs and pin
them in tests so the consumer does not depend on wording changes.
