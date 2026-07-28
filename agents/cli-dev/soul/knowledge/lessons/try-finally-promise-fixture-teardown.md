---
type: Lesson
title: Returning a promise from try/finally restores the fixture before the test body runs
description: A test that set PATH to a fake runtime and returned an imported promise from the try block had PATH restored before the body executed, so it silently exercised the machine's real toolchain.
tags: [testing, async, fixtures, javascript]
timestamp: 2026-07-27
---

# Lesson

```js
try { return import("../lib/core.mjs").then((core) => { /* body */ }); }
finally { process.env.PATH = oldPath; }
```

`finally` runs when the try block RETURNS, not when the returned promise settles. So the
fake `pi`/`claude` on `PATH` was already gone by the time the body spawned anything: the
test passed only because this machine happens to have a real `pi` installed, and it would
fail on a clean host — or worse, pass while testing something entirely different from what
it claimed.

I confirmed the mechanism in six lines rather than arguing about it:

```
promise form — fake PATH in effect for the body: false
await   form — fake PATH in effect for the body: true
```

**Any fixture torn down in `finally` requires the body to be `await`ed inside the `try`.**
Make the test `async` and await; returning a promise from a try/finally is the same class of
bug as returning it from a `using`/lock scope.

The tell is worth memorising: a test that sets up an environment fixture AND contains
`return somePromise` in the same try block is almost certainly not using its fixture. Cleanup
that must outlive the body has to sit after the await, not around the return.
