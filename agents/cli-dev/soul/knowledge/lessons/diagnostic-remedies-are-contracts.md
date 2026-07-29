---
type: Lesson
title: Diagnostic remedies are executable contracts
description: A diagnostic that names a repair path must be tested as a contract; the refused operation can be correct while its advice still sends operators into loops.
tags: [packages, oas-cli, diagnostics, capability-materialization, testing]
timestamp: 2026-07-29
---

A diagnostic that names a remedy is part of the behavior contract, not incidental prose. The guarded operation can be correct in every observable way — right state, no mutation, correct refusal — while the sentence it prints sends the operator into a repair loop.

The package path-mismatch refusal is the concrete example. `acquirePackage` rejects a resolved package path that differs from the already locked path as `integrity-drift`; the repair advice must follow the [payload-root ownership contract](/decisions/package-payload-root-contract.md): catalog locks can say `oas update <pkg>` because the catalog owns the `path` field and update re-reads it, while Git locks must not name update because the operator's `#<path>` fragment is sticky across updates and the real route is remove-then-install with the intended fragment.

Test the remedy, not only the refusal. Pin each branch at the surface that prints it, assert the expected advice appears, and add `doesNotMatch` assertions for the other branch's advice so future edits cannot collapse the cases into one generic message. When cheap, mutation-check both directions: forcing either branch's text should kill the relevant package-engine and CLI lifecycle tests.
