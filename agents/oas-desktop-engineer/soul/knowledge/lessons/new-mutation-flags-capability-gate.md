---
type: Lesson
title: New CLI mutation flags need a capability gate
description: Adding new spawn flags to the desktop's CLI mutation path silently corrupts behavior on older accepted v1 CLIs because the CLI parser ignores unknown options and still succeeds, so every new mutation flag needs an in-range capability check that fails closed server-side and only hides UI on proven incompatibility.
tags: [desktop, cli-adapter, versioning, degradation]
timestamp: 2026-07-25
---

Review finding on `f921f7d` (`agent-relations`): the new `--relation` /
`--relative-to` spawn flags were sent to every CLI accepted as Desktop API v1
(`>=0.18.0 <0.19.0`). Released v1 CLIs that predate the relation feature ignore
unknown spawn options and still return success, so a "child" spawn would silently
create an unrelated instance while the desktop reports success.

# Pattern

For any new mutation flag inside an existing API range:

1. Define a version floor (`RELATIONS_MIN`) or probe capability next to the
   acceptance rules in `cli-locator.mjs`, with an importable invariant-bearing
   gate such as `relationSupportError(cliState, opts)` so the regression
   exercises the exact layer.
2. The server fails closed with a stable error code such as `cli-no-relations`
   before invoking the adapter; never rely on the old CLI erroring.
3. Expose the capability in `/api/cli` (`relations: boolean`) and gate the
   renderer UI on it, but follow the shared degradation rule: unknown capability
   probe data from an older backend or a test stub still renders capable. Only a
   proven `false` hides or disables the UI. The server-side gate is the real
   guard; see [Shared degradation state must treat unknown as capable](/lessons/degradation-state-unknown-capable.md).
4. Regression tests prove an older in-range version cannot perform the new
   mutation while plain mutations keep working, and they exercise the production
   gate layer; see [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md).
