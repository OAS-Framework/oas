---
type: Lesson
title: JSON contracts must cover dispatcher and process boundaries
description: A command's --json envelope guarantee is void unless the JSON-aware boundary wraps the whole path, including dispatcher setup, pre-report throws, child spawn failures, and spawned children's stdout.
tags: [cli, json, contract, capabilities]
timestamp: 2026-07-26
---

# Lesson

Review of `e0f6e68` caught that `oas okf harvest --json` only honored the
JSON envelope once the OKF executable ran. The kernel's `capabilityCommand()`
dispatcher could still fail first with stderr or stdout help for inactive
namespaces, untrusted executables, duplicate namespaces, unknown subcommands,
unknown namespaces, and malformed `instance.json` JSON.

This extends the [JSON-mode CLI contract](/lessons/json-mode-cli-contract.md):
all layers that can reach stdout need the JSON boundary, not only the final
command implementation. Later review of `install --json` in `5fd9158` found
the same class of contract leak inside the command path: inherited child stdio
can print before the envelope, and pre-report exceptions can leave empty stdout
with only a stack trace.

Patterns that generalized from the fix:

- put a `bail(code, msg)` helper inside the dispatcher, choosing `jsonFail` or
  human `die()` before any dispatcher failure can print non-JSON output;
- wrap the whole dispatcher body in one `try`; use a non-error sentinel such as
  `NOT_DISPATCHED` for the only legitimate fallthrough ("no namespace matched")
  instead of relying on exceptions or partial guarding;
- map child `spawnSync` errors (`r.error`, child never ran) and unclassified
  dispatcher exceptions to stable JSON failure envelopes such as
  `E_CAPABILITY_BROKEN`, while narrower guarded failures can keep specific codes
  such as `E_CONFIG_BROKEN`;
- validate third-party manifest command values before use (`commands[sub]` must
  be a non-empty string before `.split()`), because manifest discovery, trust
  checks, and manifest decoding can all throw before the capability process
  starts;
- move fallible module-top-level initialization, such as inherited
  `OAS_SETTINGS` parsing, inside the command boundary;
- keep command implementations as thin JSON-aware boundaries around their full
  fallible path, so exceptions thrown before the normal report call still emit
  `{schemaVersion, ok:false, error:{code,message}}` in JSON mode, preserving
  `e.code` when present;
- in JSON mode, do not let spawned children inherit stdout: route child stdout
  and stderr to the parent's stderr, for example `stdio: ["ignore", 2, 2]`,
  while human mode may keep `inherit`;
- test the contract end-to-end through `CLI <namespace> <subcommand> --json`,
  because directly invoking a capability executable cannot see dispatcher
  failures, and add noisy-child shims that prove `JSON.parse(r.stdout)` works
  on the whole stdout for both successful and failing child exits.

Also, `oas.okf` is a fundamental-layer capability: test configs that need it
must declare it under `capabilities.layers.knowledge`, not `additive`, or the
configuration fails with `E_CONFIG_BROKEN`.
