---
type: Lesson
title: Materialized npm closures must be integrity-bound into package trust
description: Excluding node_modules from packageIntegrity creates a trust bypass unless materialized dependency trees have their own depsIntegrity digest that trust, approval carry-over, and restore all verify.
tags: [trust, integrity, npm, packages, security]
timestamp: 2026-07-26
---

# depsIntegrity binds executable materialization

Reviewer-caught blocker: `packageIntegrity` deliberately excludes
`node_modules` so dependency materialization does not change the locked source
hash. Trust initially checked only that hash; after approval, tampering
`node_modules/<dep>/index.js` kept trust green while the capability executed the
replacement.

General rule: any executable derived artifact excluded from an integrity hash
needs its own bound digest. For package npm closures, that digest is
`depsIntegrity`.

# Fix pattern

- `packageDepsIntegrity(dir)` digests every `node_modules` tree under the root;
  it is undefined for an empty closure because `npm ci` may create no
  `node_modules` directory.
- Lock entries carry optional `depsIntegrity`. Approval carry-over is valid only
  when both the source integrity and dependency digest match.
- Materialize dependencies in staging before any destination mutation; failure
  aborts the whole transaction instead of becoming a best-effort after-commit
  step.
- Restore re-materializes in staging and verifies the result against the locked
  digest before the swap. A mismatch is integrity drift, and the prior artifact
  stays in place.

# Related contract lesson

The same review showed that exported contract signatures need direct regression
tests against the frozen contract doc. `capabilityTrust` had drifted to an
internal `(manifest, startDir)` shape; compatibility required keeping both via
`typeof` dispatch. See the [frozen-interface-first delivery lesson](/lessons/frozen-interface-first-delivery.md).
