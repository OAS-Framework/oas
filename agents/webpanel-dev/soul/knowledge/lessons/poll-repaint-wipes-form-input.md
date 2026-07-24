---
type: Lesson
title: Periodic repaints must not rebuild DOM under open forms
description: Periodic roster polls must treat an open form as a repaint barrier, because rebuilding the DOM can erase typed-but-unsubmitted spawn text and submit task "".
tags: [desktop-app, spawn, forms, polling, data-loss, renderer, gotcha]
timestamp: 2026-07-24
---

# Periodic repaints must not rebuild DOM under open forms

# The bug

The desktop Spawn view periodically refreshed the roster every 8 seconds. Its
`renderGrid` repaint guard preserved the grid only when a spawn was already in
flight:

```js
grid.querySelector(".soul-form button:disabled")
```

That checked for a disabled submit button, not for user-owned form state. If the
poll fired while the user was typing a task, the grid rebuilt, replaced the open
form with a visually identical empty form, and the next Spawn click submitted
`task: ""`. The server-side spawn path still honored the
[empty-task semantics](/architecture/spawn-endpoint.md); the task was lost before
the POST body was produced.

# The fix

Protect any open form owned by the current selection, not only disabled/in-flight
forms. Tag cards with the agent name, but do not interpolate that name into a
CSS selector. Suppress poll repaints by iterating the static card set and
comparing dataset identity in JavaScript:

```js
s.sel && [...grid.querySelectorAll(".soul-card")].some(
  (card) => card.dataset.agent === s.sel && card.querySelector(".soul-form"),
)
```

Explicit re-renders such as cancel or selecting another soul mutate `s.sel`
first, so they still rebuild. The barrier is for periodic poll repaint under a
live form with uncommitted DOM-held user state. The earlier escaped-selector
version was superseded by [the no-dynamic-selectors lesson](/lessons/no-dynamic-selectors-from-data.md),
because local names can shadow the global `CSS.escape` helper and raw selector
fallbacks can throw or match the wrong card.

# General rule

Any periodically repainted renderer surface that can host user input must treat
an editable control with uncommitted user state as a repaint barrier. "No async
mutation is in flight" is not the same as "there is no user state to lose";
typing exists in the DOM before any request or operation token exists. This
complements [shared-form operation ownership](/lessons/shared-form-operation-token.md),
which protects the same form after async dispatch.

# Regression pattern

Capture the poll callback from a fake `setInterval`, open the spawn form, set the
task field value without submitting, fire the poll callback, and assert the same
field element identity survives with its value intact. Then submit and assert the
POST body contains the typed multiline task.
