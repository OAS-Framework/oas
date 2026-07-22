---
type: Lesson
title: Async tab lifecycle cleanup must track fulfillment and awaitable key reservations
description: When a desktop tab closes during async mount, cleanup must wait for settle, fall back to module unmount only after a fulfilled legacy mount, and make dedup-key reservations awaitable so fast reopens queue behind cleanup.
tags: [desktop, view-host, async, race, lifecycle, queueing]
timestamp: 2026-07-22
---

A follow-up review of the [per-mount disposer contract](view-mount-disposer-contract.md)
found a second-order race: `onClose` checked `made.dispose` while async
`mount()` was still awaiting the API. Because the disposer was not captured
yet, close fell back to module-wide `unmount()`, which clears every open mount
of that module. Quick-closing a loading markdown tab still blanked a settled
one.

The fix shape lives in `renderer/view-lifecycle.mjs` as
`createViewLifecycle(mod)` and treats the tab lifecycle as explicit state:

- close before settle → record `closed` and do nothing yet;
- mount resolves → mark `fulfilled`, capture the returned disposer, and if
  already closed, run cleanup immediately using that mount's disposer or
  module `unmount()` only for a fulfilled legacy view;
- mount rejects → mark settled but not fulfilled, and never infer "legacy
  view" from the missing disposer;
- close after settle → run the same cleanup path once.

A later review found the matching dedup-key race: if the tab key is freed when
close is requested, a user can reopen the tab before deferred cleanup finishes;
the stale lifecycle's later module-wide `unmount()` can then tear down the new
mount. The host keeps the key reserved until the tab's `close()` promise
resolves after cleanup, but reserved-key open requests must wait instead of
being refused. Returning `null` for a temporarily reserved key is ambiguous with
"existing tab activated", so `openViewTab` can silently drop the user's
close→fast-reopen intent and leave no tab. The fix shape is
`reserveKey(key, cleanupPromise)` plus `whenKeyFree(key)`: store the cleanup
promise per key, make every keyed open await `whenKeyFree(key)` before the
dedup scan and mount, and delete the reservation in a
`.catch(() => {}).finally(...)` path so failed cleanup still releases the key.

The lifecycle is DOM-free so deferred-promise unit tests can drive the races
deterministically: close-mid-mount, legacy view, mount error, and two lifecycles
of one module with a mid-flight close.

General rules:

- Whenever cleanup depends on a value produced by an in-flight async operation,
  closing must wait for settle. Checking "is the cleanup value there yet?" at
  close time is the race, not the fix.
- Every async fallback path needs a state bit for what actually happened. A
  rejected mount and a fulfilled legacy mount both lack a disposer, but only
  the fulfilled legacy mount may use module-wide fallback cleanup.
- Any resource freed "on close" should really be freed on cleanup-complete;
  the gap between those two moments is where reopens live.
- A reservation on a shared resource needs an awaitable handle so blocked
  requests can queue. A boolean "is reserved" check can only drop the request
  or recreate the race; test the host composition path, not only a manually
  chained lifecycle sequence.
