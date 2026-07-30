---
type: Lesson
title: A gate that cannot see required data needs a rollback-equivalent fallback
description: Acquisition's preview omitted the capability manifest, so template layer agreement could not be checked before mutation; deferring only that check to post-commit with full rollback kept it fail-closed without making layer-binding packages unadoptable.
tags: [cli, validation, transactions, gates, rollback, seams, testing]
timestamp: 2026-07-29
---

The capability-materialization engine exposes a pre-commit gate (`acquirePackage(..., { assertCommittable })`) that runs after the whole closure is projected in staging and before any mutation. It is the right place for guided `oas init --package` config-template validation, because a refusal there needs no rollback.

# The preview gap

Preview capability rows carried `{capability, version, package, path, integrity, trusted, status, executableSurface}` — no capability manifest, and no exposed staging paths. A config template that binds an exclusive layer to one of the package's **own** not-yet-materialized capabilities therefore could not have that binding checked in the gate: there was nothing to compare the declared layer against.

This was not a corner case. A package whose template binds its own capability to a layer is the architecture decision's primary example shape.

# Why failing open was not acceptable

Accepting an unverified layer binding produces a config whose resolution fails later, at spawn, far from the adoption that caused it. That has the same fail-open shape as the targeted-capability requirements bug recorded in [aggregate requirements for targeted capabilities](/lessons/aggregate-requirements-targeted-capabilities.md): validation that silently skips the case it cannot see is worse than validation that is honestly absent, because it reads as coverage.

# The fallback that stays fail-closed

Defer **exactly** the unverifiable bindings and re-validate them after the engine commits but before finalizing the run journal. The capabilities are materialized by then, so every layer can be checked against the real manifest. A disagreement aborts and the journal restores the scope completely; the user-visible outcome is equivalent to a gate refusal, just later and after fetch/copy work has already happened.

Everything the preview can answer — schema, capability supply, path escapes, agent-type syntax, layers onto already-materialized capabilities — still refuses pre-commit. The durable rule: when a gate cannot see what it must judge, move the judgement to the first point where the data exists and make failure there equivalent to refusal. Do not weaken the check to fit the gate.

The seam request remains worthwhile: a one-field addition (`layer` on preview capability rows, derived from the validated manifest and `null` when absent) would restore cheap pre-mutation refusal. Ship the rollback fallback as an honest interim, not as a reason to stop asking.

# The test fixture must reach the fallback

The rollback regression for this transaction passed on the first try, and then passed against a mutant that removed the restoration. It was worthless: the run was being refused at `integrity-drift` during acquisition and never reached the post-commit path.

Same-identity/different-bytes reacquisition is refused by design, so the obvious fixture cannot exercise post-commit rollback. The fixture that works **drifts the installed artifact on disk first**: reacquiring the same locked package then genuinely reprojects the pre-existing same-name capability, so the engine really commits before the injected failure. The assertion must expect the drifted bytes to return, because rollback restores the state the command started from, not an idealized one.

This is the transaction-specific instance of the [run-level rollback journal](/lessons/run-level-rollback-journal-craft.md) testing rule: for any "state is restored after failure" test, run a mutant that removes the restoration. If it still passes, the fixture is failing earlier than the code under test and the assertion is decorative.
