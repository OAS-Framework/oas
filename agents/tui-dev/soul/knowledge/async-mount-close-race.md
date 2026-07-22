---
type: Lesson
title: Async resource lifecycles must handle close during pending acquisition
description: When a desktop owner can close during async mount or terminal open, lifecycle state must track closed/settled/fulfilled, release late materialized resources immediately, and keep dedup-key reservations awaitable until cleanup completes.
tags: [desktop, view-host, async, race, lifecycle, queueing, pty]
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

The same disease appeared again in terminal tabs: `cleanup()` checked
`ptyId !== null` while `termOpen()` was still awaiting, so closing during the
pending open leaked an invisible attached tmux client until app shutdown when
the id arrived after the tab died. The terminal fix mirrors the view lifecycle
with `createTermLifecycle`: a late pty materialization on an already-closed tab
immediately calls `closePty(id)` and skips data/exit handler wiring; rejection
after close is silent; rejection while live shows the error banner; `forget()`
covers session-ended cases where main already dropped the pty; and closePty
failures are absorbed so UI teardown still completes. This is the cleanup side
of the [direct tmux attach terminal contract](desktop-terminal-direct-attach.md).

General rules:

- Whenever cleanup depends on a value produced by an in-flight async operation,
  closing must wait for settle. Checking "is the cleanup value there yet?" at
  close time is the race, not the fix; if the value materializes after close,
  release it immediately in the acquisition continuation before exposing it to
  the dead owner.
- Every async fallback path needs a state bit for what actually happened. A
  rejected mount and a fulfilled legacy mount both lack a disposer, but only
  the fulfilled legacy mount may use module-wide fallback cleanup.
- Any resource freed "on close" should really be freed on cleanup-complete;
  the gap between those two moments is where reopens live.
- A reservation on a shared resource needs an awaitable handle so blocked
  requests can queue. A boolean "is reserved" check can only drop the request
  or recreate the race; test the host composition path, not only a manually
  chained lifecycle sequence.
