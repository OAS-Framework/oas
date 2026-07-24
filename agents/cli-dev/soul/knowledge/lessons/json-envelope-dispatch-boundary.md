---
type: Lesson
title: JSON contracts must cover dispatcher boundaries
description: A capability command's --json envelope guarantee is void if the generic CLI dispatcher can fail before the command boundary and print help or stderr instead.
tags: [cli, json, contract, capabilities]
timestamp: 2026-07-24
---

# Lesson

Review of `e0f6e68` caught that `oas okf harvest --json` only honored the
JSON envelope once the OKF executable ran. The kernel's `capabilityCommand()`
dispatcher could still fail first with stderr or stdout help for inactive
namespaces, untrusted executables, duplicate namespaces, unknown subcommands,
unknown namespaces, and malformed `instance.json` JSON.

This extends the [JSON-mode CLI contract](/lessons/json-mode-cli-contract.md):
all layers that can reach stdout need the JSON boundary, not only the final
command implementation.

Patterns that generalized from the fix:

- put a `bail(code, msg)` helper inside the dispatcher, choosing `jsonFail` or
  human `die()` before any dispatcher failure can print non-JSON output;
- cover the "no namespace matched" fallthrough that would otherwise print help
  text to stdout;
- map child `spawnSync` errors (`r.error`, child never ran) to the same JSON
  failure envelope;
- move fallible module-top-level initialization, such as inherited
  `OAS_SETTINGS` parsing, inside the command boundary;
- test the contract end-to-end through `CLI <namespace> <subcommand> --json`,
  because directly invoking a capability executable cannot see dispatcher
  failures.

Also, `oas.okf` is a fundamental-layer capability: test configs that need it
must declare it under `capabilities.layers.knowledge`, not `additive`, or the
configuration fails with `E_CONFIG_BROKEN`.
