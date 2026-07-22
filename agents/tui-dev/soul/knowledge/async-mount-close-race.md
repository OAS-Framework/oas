---
type: Lesson
title: Async mount close race — cleanup must wait for settle
description: When a tab host supports async mount() returning a disposer, a close during the pending mount must defer cleanup until mount settles and then run that mount's disposer.
tags: [desktop, view-host, async, race, lifecycle]
timestamp: 2026-07-22
---

A follow-up review of the [per-mount disposer contract](view-mount-disposer-contract.md)
found a second-order race: `onClose` checked `made.dispose` while async
`mount()` was still awaiting the API. Because the disposer was not captured
yet, close fell back to module-wide `unmount()`, which clears every open mount
of that module. Quick-closing a loading markdown tab still blanked a settled
one.

The fix shape lives in `renderer/view-lifecycle.mjs` as
`createViewLifecycle(mod)`:

- close before settle → record `closed` and do nothing;
- mount settles → capture the returned disposer, and if `closed`, run cleanup
  immediately using that mount's disposer, or module `unmount()` only for
  legacy views;
- close after settle → run cleanup immediately.

The lifecycle is DOM-free so deferred-promise unit tests can drive the race
deterministically: close-mid-mount, legacy view, mount error, and two lifecycles
of one module with a mid-flight close.

General rule: whenever cleanup depends on a value produced by an in-flight
async operation, closing must wait for settle. Checking "is the cleanup value
there yet?" at close time is the race, not the fix.
