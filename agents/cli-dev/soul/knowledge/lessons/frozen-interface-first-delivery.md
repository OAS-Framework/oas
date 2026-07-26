---
type: Lesson
title: Frozen-interface-first delivery for multi-workstream contracts
description: When sibling workstreams block on a shared contract, ship the schemas plus a contract doc with exact function signatures and error codes as a standalone first commit before any implementation.
tags: [process, contracts, packages]
timestamp: 2026-07-26
---

# Lesson

For the package-engine workstream, two sibling teams blocked on the shared
contract. The effective move was to push a first commit containing only:

- machine-readable JSON Schemas (`oas-package.json`, `oas-lock.json` v2, and
  legacy v1);
- a design doc (`docs/design/package-engine-contract.md`) freezing the source
  grammar and normalized identity;
- the store layout;
- exported kernel function signatures in JSDoc style;
- consumer notes mapping which workstream consumes which function; and
- a stable error-code table that also served as the `--json` envelope codes.

Key judgment calls worth repeating:

- Lock keys by package identity from the acquired manifest, never derived from
  the source string; record the normalized source separately.
- Keep the catalog resolver as an injection point (`opts.catalog`) so tests use
  a fixture and the real content owner handles live catalog content;
  identity/discovery only belongs in this contract.
- Use `commit: "local"` as the sentinel for path sources so the lock shape stays
  uniform.
- Pre-commit the `--json` error taxonomy in the frozen doc, matching the
  existing [JSON-mode CLI contract](/lessons/json-mode-cli-contract.md) and
  [dispatcher-boundary](/lessons/json-envelope-dispatch-boundary.md) lessons.
