---
type: Lesson
title: Reconciliation truthfulness — side effects must match reports and exit codes
description: Workspace reconciliation must control side effects before reporting: restore and verify each lock level once across every path, fail locked-but-uninstalled v2 package entries, and make consented requirement install failures nonzero.
tags: [install, reconciliation, requirements, review, exit-codes]
timestamp: 2026-07-26
---

# Lesson

Post-commit review of the phase-1 reconciler found three report-vs-reality gaps:
output filtering is not side-effect control, and printing a failure is not the
same as failing the command.

1. **Restore each lock level once.** `restoreCapabilities(scope)` walks
   lockfiles upward from the scope. Calling it for every discovered descendant
   and filtering `r.level === scope` afterwards still re-runs every ancestor
   restore per descendant, and hides ancestor failures in the descendant report.
   Use exact-level restore (`restoreCapabilities(startDir, { levels })`) plus a
   `restoredLevels` set so the boundary keeps chain semantics while descendants
   restore only their own not-yet-processed level. If a later package-engine seam
   replacement lacks that exact-level option, the consumer must preserve the fix
   another way instead of reverting to filter-after-side-effect; see the
   [API-swap regression lesson](/lessons/api-swap-regression-fix-mechanisms.md).
   A follow-up review caught the
   inverse coverage gap: package-lock verification added only inside the
   boundary/recursive loop missed the ordinary non-team `restore(dir)` chain and
   the boundary's ancestor lock levels. Keep per-level checks extracted (for
   example `packageLockReport(level)` plus `lockLevelsUp(dir)`) and call them
   from both the chain path and the deduplicated reconciliation levels. This
   corrects the older filtering-only warning in
   [team-boundary workspace discovery](/lessons/team-boundary-scan-pruning.md).
2. **Locked package entries are obligations, not comments.** v2 `packages`
   entries were consulted as validation metadata, so a scope whose only lock was
   a v2 package entry could exit 0 with the artifact absent. Until the engine's
   package restore path is wired in, a locked-but-uninstalled package is an
   explicit `FAILED` line plus nonzero exit.
3. **Consented install failures are fatal.** `--accept-requirement` manager
   failures and post-install PATH verification misses must increment a failed
   count and make `oas install` exit nonzero. Unaccepted/skipped requirements
   stay non-fatal; only a consented attempt that fails becomes a CI failure.

Regression coverage should assert the observable truth, not only printed text:
count repeated capability names to prove "once per level", and make restore
attempts observable when output dedupes can lie. For package/capability restore
dedupe, use a nested descendant under the locked scope plus a recording `cp`
shim on `PATH`; a wrong-integrity lock makes each retry visible as copy,
integrity failure, and cleanup. Use fake npm shims for both consented-failure
modes (manager exits nonzero; manager exits 0 without dropping the binary on
PATH). The broader fixture pattern lives in
[test conventions](/playbooks/test-conventions.md), and requirement argv/PATH
verification is covered by
[requirement install recipes](/lessons/requirement-recipes-data-allowlist.md).
