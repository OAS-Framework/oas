---
type: Lesson
title: Scope rollback of a merged stage keeps the manifest tests as absence pins
description: When a merged nav stage is rejected as scope overreach, invert the reachability suite into inventory-style absence pins (NAV excludes it, view file gone, no references) instead of deleting the tests.
tags: [desktop, shell, navigation, scope, rollback, regression-tests]
timestamp: 2026-07-25
---

PR #29 shipped a first-class "Instances" nav stage; the surface was rejected as
scope overreach: no new tab, no extra sidebar, because the sidebar roster is the
instances context. The rollback deleted `views/instances.mjs` and its `NAV`
entry, but did not delete `shell-nav.test.mjs`; the suite was inverted to pin
absence instead.

For a rolled-back stage, keep shell-level regression coverage as an absence
manifest: assert `NAV` is exactly the shipped set, assert the removed view module
does not exist, and assert shell sources and harnesses carry no import or
`data-view` entry for the removed view. This mirrors the dormant-surface removal
discipline: a reverted surface needs the same absence proof a deleted dormant one
does, or a stray cherry-pick can reship it.

Also grep the whole repo for the view name when removing a desktop view.
Root-level tests such as `tests/desktop-views.test.mjs` and
`test/desktop-server.test.mjs` hard-code shipped view names and counts, so
searching only under `packages/desktop/` misses required rollback edits.

# Related concepts

- [Shell nav reachability needs an importable manifest](/lessons/shell-nav-reachability-manifest.md)
- [Dormant surface removal inventory](/lessons/dormant-surface-removal-inventory.md)
