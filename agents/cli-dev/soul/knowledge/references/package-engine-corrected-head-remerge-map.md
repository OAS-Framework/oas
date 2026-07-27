---
type: Reference
title: Package-engine corrected-head re-merge map
description: Frozen-branch map for absorbing the corrected package-engine head after 054f7ba: fail-closed invalid-lock reads, materialized-dependency containment, depsIntegrity validation, canonical CLI env, residue and migration fixes, and JSON-envelope updates.
tags: [packages, gate-2, re-merge, freeze]
timestamp: 2026-07-26
---

# Re-merge pre-map: 054f7ba to corrected engine head

The frozen branch at b4d3188 had merged engine head 054f7ba, which predated the
corrective chain. When WS1 broadcasts c62a30e or later, absorb these deltas:

- 864b837, f832ba9, 54d1562: corrective chain for the maintainer's five
  findings plus the `__proto__` lock-forgery blocker.
- 5b3ba1a, 01be2f7: migration rollback completeness, install compensation, and
  retained-package residue collision.
- 6f0a3bd, c62a30e: JSON-envelope completeness, frozen codes, bulk-trust
  preview, and skill accuracy.

# Consumption points to re-verify

1. **`readPackageLocks` raises typed `invalid-lock`** instead of skipping or
   returning empty. Wrap and surface the code at the WS2 call sites: doctor
   package data, doctor human section plus migration residue,
   `dependencyClosureCapabilities`, `initPackage` URL/catalog probe, commit
   lookup, post-snapshot lock report, `listCmd`, and
   `lockedPackageCapabilities` in `lib/packages.mjs`. Doctor should diagnose,
   reconcile rows should carry the code, and JSON envelopes should pass
   `invalid-lock` through verbatim; never soften this to empty.
2. **`lockError` was removed from `listInstalledPackages`.** Re-check the
   corrected-head surface and update doctor human output, `list --json`, and
   list human output to use the replacement typed throw or diagnostics surface.
3. **`assertMaterializedDepsContained` adds symlink containment** for
   `node_modules`; restore/acquire paths and reconciliation rows may now carry
   `path-escape`.
4. **`depsIntegrity` format validation** in `validateLockEntry` rejects
   malformed `depsIntegrity`.
5. **`OAS_CLI_BIN` runtime env contract.** The corrected head passes a
   canonical absolute CLI path in `OAS_CLI_BIN`; packages invoke it with
   `execFile`, never by relying on `PATH`. Confirm WS2 capability dispatch gains
   the variable after re-merge; the 054f7ba branch only set `OAS_SETTINGS` and
   `OAS_TEAM_*`. Also check the platform-invariant v1 `depsIntegrity`
   comparison in doctor.
6. **`skills/oas-packages` wording changed.** Re-sync the oas-config and
   getting-started routing wording at integration, then execute the
   content-migration split.
7. **Acquire-package lock-integrity fix.** When the relayed corrective item
   lands, batch item 6's regression should assert the fixed behavior and drop
   any pinned-current-behavior fallback.

Merge risk: `bin/oas.mjs` changed in the same doctor/install/restore regions as
the teardown edits. Resolve with the same disposition: engine remains resolver
truth, while WS2 keeps policy and envelope mapping. See
[package-engine seam teardown](/decisions/package-engine-seam-teardown.md) and
[gate-2 seam teardown execution](/lessons/gate2-seam-teardown-execution.md).
