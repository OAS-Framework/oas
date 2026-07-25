---
type: Lesson
title: Kernel validation must precede spawn side effects
description: spawnInstance options that can be rejected (relations, anchors) must be parsed and resolved before mkdir/hooks because CLI prechecks do not protect direct kernel callers.
tags: [spawn, kernel, validation, lifecycle-hooks, relations]
timestamp: 2026-07-25
---

# Lesson

Review of the spawn-relations feature (5aa0420 → fixed in 3bc4d72) surfaced
that CLI validation is not enough for options accepted by the exported core API.
A CLI `E_BAD_ARGS` precheck protects only the CLI path; direct callers of
`spawnInstance` still reach the kernel.

Any spawn option that can be rejected — relation matrix values, anchor existence,
or anchor lineage read failures — must be parsed and resolved before
`mkdirSync(home)` and before capability spawn hooks run. Hooks can provision real
external state, such as aweb identities; throwing after hooks or home creation can
leave a half-created instance home plus orphaned external state.

The kernel must read the anchor's `instance.json` when validating relation
options, not rely only on an earlier CLI check, because anchor state can change
between the CLI check and the kernel read. Relation tests should assert both the
stable failure and the absence of a created instance directory.

Explicit "none" values also need to survive normalization. Normalizing
`relation: "unrelated"` to `undefined` too early erases the difference between
"caller omitted relation" and "caller explicitly requested no link"; attached
mode can then auto-parent despite the explicit negation. Keep an
`explicitUnrelated`-style fact through fallback/default handling, then record no
lineage fields for the unrelated result.

See also [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md)
and [test-conventions](/playbooks/test-conventions.md).
