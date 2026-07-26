---
type: Lesson
title: Align phase-1 package fixtures to frozen engine envelopes and error codes
description: When a sibling package-engine workstream freezes an interface, align shared-reader return envelopes, schema-verbatim fixture data, and the shared error-code taxonomy before treating the seam as swappable.
tags: [packages, contract, fixtures, error-codes]
timestamp: 2026-07-26
---

# Lesson

When a sibling package-engine workstream freezes an interface, align the exact
contract shape before relying on phase-1 code as swappable. The WS1
package-engine freeze (`feature/package-engine` at `1db919b`) exposed these
highest-value alignment points:

- **Envelope shape of shared readers**: `readPackageLocks` returns
  `{ packages, legacy }`, not a bare id-to-entry map. Legacy v1 files surface
  separately and untouched. Match that envelope early so later integration is a
  re-import instead of a call-site rewrite.
- **Schema-verbatim fixture data**: identity/profile names use
  `^[a-z0-9][a-z0-9._-]*$` (dots and underscores allowed); path sources still
  require `commit: "local"`; integrity strings match `^sha256-[0-9a-f]{64}$`.
  Placeholder values such as `sha256-fixture` violate the contract. Slug can
  equal identity because the charset forbids `/` and `@`.
- **Error codes as `error.code`**: reuse the package-engine taxonomy
  (`invalid-package-manifest`, `path-escape`, `invalid-source`, …) on thrown
  `Error` objects so `--json` envelopes and tests stay stable across the seam.
  Add local codes only for local-only surfaces such as consent, boundary, or
  profile validation.

Read frozen sibling contracts read-only with `git show origin/<branch>:<path>`.
Do not merge or branch from the sibling workstream ref; feature-branch
integration is brokered separately. For the broader JSON envelope rule, see
[json-mode-cli-contract](/lessons/json-mode-cli-contract.md).
