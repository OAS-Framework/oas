---
type: Lesson
title: Cross-resource validators must enforce cardinality before invariants
description: Validation that compares package and capability metadata must reject missing or extra resources before running one-item invariants.
tags:
  - packages
  - validation
  - tests
timestamp: 2026-07-26
---

# Cross-resource validators must enforce cardinality before invariants

A package validator guarded identity/version/compatibility checks with `capabilities.length === 1` but did not independently require one declared capability. Removing `capabilities[]` or adding a second capability therefore bypassed the cross-resource checks and still returned success.

For a repository contract that intentionally exports exactly one capability:

1. validate the declaration's cardinality first and fail unless it is exactly one;
2. only then load the resource and compare package ID, version, and compatibility;
3. add negative tests for both zero and multiple entries, not only a valid fixture; and
4. keep the exact-one policy separate from the generic outer schema when the schema also supports multi-capability packages.

The general lesson is to avoid using a precondition as a silent guard around important validation. If the precondition is itself part of the local contract, validate it explicitly.
