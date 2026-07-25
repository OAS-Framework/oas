---
type: Lesson
title: Shell nav reachability needs an importable manifest
description: A desktop view is not shipped until the shell-level nav manifest lists it, loads its mount-exporting module, and has tests proving shell.mjs consumes that manifest instead of shadowing or special-casing the route.
tags: [desktop, shell, navigation, reachability, regression-tests]
timestamp: 2026-07-25
---

The roster-grouping work produced a fully tested `views/instances.mjs`, but the
production shell still made the view unreachable: `shell.mjs` kept an inline
`const NAV` with only hierarchy and spawn, while `ctx.openView("instances")`
was special-cased to focus the permanent sidebar filter instead of mounting the
stage view. Module-level view tests did not see the broken wiring.

For nav rail destinations, the invariant belongs in an importable manifest. The
fix extracted `renderer/shell-nav.mjs` with `NAV`, `stageSidebarMode(name)`, and
`loadStageView(name)`, using the same `new URL(..., import.meta.url)` dynamic
import shape as the stage host so the loader resolves in tests as well as the
app.

Shell-level regression coverage should prove all three reachability facts:

- `NAV` includes every required rail destination with the expected chrome;
- every `NAV` entry dynamically imports a view module that exports `mount` and
  `unmount`;
- `shell.mjs` imports `NAV` from the manifest, has no shadowing local `NAV`, and
  routes `openView(name)` through the stage loader instead of per-view focus
  special cases.

Lesson: a feature is not delivered until a shell-level test proves a user can
reach it. "The view exists" and "the view mounts in module tests" are necessary
but not sufficient.

# Related concepts

- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
- [Desktop shell view integration lessons](/lessons/desktop-shell-view-integration-lessons.md)
- [Contract-test the shared desktop renderer harness against shipped views](/lessons/shared-renderer-harness-enumeration-test.md)
- [Scope rollback of a merged stage keeps the manifest tests as absence pins](/lessons/scope-rollback-absence-pins.md)
