---
type: Lesson
title: Kernel validation must precede option normalization and spawn side effects
description: spawnInstance options that can be rejected (relations, anchors, relation sugar conflicts) must be checked in their raw caller shape before normalization and before mkdir/hooks because CLI prechecks do not protect direct kernel callers.
tags: [spawn, kernel, validation, normalization, lifecycle-hooks, relations]
timestamp: 2026-07-25
---

# Lesson

Review of the spawn-relations feature (5aa0420 → fixed in 3bc4d72, with
merged-state option-ordering fixed in 9ee026b) surfaced that CLI validation is
not enough for options accepted by the exported core API. A CLI `E_BAD_ARGS`
precheck protects only the CLI path; direct callers of `spawnInstance` still
reach the kernel.

Any spawn option that can be rejected — relation matrix values, anchor existence,
anchor lineage read failures, or conflicts between relation sugar and explicit
relation fields — must be parsed and resolved before option normalization,
`mkdirSync(home)`, and capability spawn hooks. Hooks can provision real external
state, such as aweb identities; throwing after hooks or home creation can leave a
half-created instance home plus orphaned external state.

Validate the raw option combination exactly as the caller passed it before
expanding sugar or stripping explicit none-values. Normalizing first can silently
coerce contradictory programmatic shapes into different valid-looking operations:
`{ relativeTo }` without a relation becomes a top-level spawn, `{ relation:
"unrelated", relativeTo }` silently drops the anchor, and `{ parent, relation }`
conflicts are resolved by precedence instead of being rejected. Check unknown
values, dangling/conflicting pairs, and qualifier-without-subject cases first;
only then normalize and perform side effects.

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
