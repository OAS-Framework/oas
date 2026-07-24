---
type: Lesson
title: Shared-form async actions need operation ownership tokens
description: When one form can start overlapping async operations, capture a per-operation token and guard every post-await mutation of that shared UI — success, error, field clearing, and finally control reset — so a stale completion cannot corrupt or re-enable a newer operation.
tags: [oas-web, race-condition, forms, operation-token, spawn, gotcha]
timestamp: 2026-07-24
---

# The bug

The spawn form is shared across successive async spawn operations. A workspace
generation guard can stop a stale completion from auto-opening a terminal in the
wrong workspace, but it does not prove that the completion still owns the form.
If the user switches workspace A → B, fills the same form for a B agent, and
starts a second spawn, the late A completion can still clear B's task/purpose
fields, overwrite B's status, or re-enable the shared spawn button while B's
spawn remains in flight. The stale error path can do the same kind of write.

# The fix — form operation ownership

Give the shared form its own monotonically increasing operation token, captured
at dispatch:

```js
const myOp = ++s.spawnOp
const owns = () => myOp === s.spawnOp
```

Guard **every** post-await mutation of the shared UI with that ownership check:
success status writes, field clearing, error status writes, and `finally` button
reset/enablement. An unconditional `finally` that re-enables shared controls is a
bug as soon as a second dispatch on the same UI can overlap the first.

The operation token is separate from the workspace generation described in
[workspace-sensitive async results](/lessons/stale-response-race.md). The
workspace generation answers "is my workspace context still current?"; the form
operation token answers "am I still the operation this form belongs to?" Async
actions over shared UI may need both.

The token starts at dispatch time; it does not protect typed-but-unsubmitted
fields from being destroyed by a periodic DOM rebuild before any request exists.
Open forms with uncommitted values also need the repaint barrier described in
[Periodic repaints must not rebuild DOM under open forms](/lessons/poll-repaint-wipes-form-input.md).

# Regression pattern

Use manually released promise gates to run two overlapping `doSpawn` calls
through one fields object. Resolve the first promise late and assert that the
second operation's fields, status, and disabled state are untouched; then resolve
the second and assert normal completion. Cover the stale error path with a
rejected first gate so late failures cannot overwrite the current operation's UI.
