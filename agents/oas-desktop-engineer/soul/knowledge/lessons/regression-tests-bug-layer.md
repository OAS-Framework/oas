---
type: Lesson
title: Regression tests must exercise the layer that had the bug
description: A regression test only pins a bug if it executes the code layer whose ordering or guard was wrong; for composition roots, move invariant-bearing lines into importable modules and leave entry points as one-line bindings.
tags: [testing, regression, desktop, composition, mutation]
timestamp: 2026-07-24
---

A reviewer found a terminal ordering regression test that exercised
`createTermLifecycle`, even though the buggy change lived in the caller's
composition code in `shell.mjs`. The test therefore also passed against the
parent commit where setup happened after `await start()`, so it pinned the
helper but not the bug.

A second review found the same mistake in a terminal preflight regression: the
test re-proved isolated tmux behavior while `main.mjs`'s preflight could be
deleted with the suite still green. The fix shape was again to extract the
buggy sequence with injectable dependencies and assert the order directly:
`openTerm` must build the [anchored target](/lessons/anchor-tmux-attach-targets.md), run
preflight, and only then spawn. A failed preflight records preflight only and no
spawn; a successful path uses the same anchored target through the ordered
steps.

Later workspace-add review rounds made the same failure sharper in `main.mjs`:
tests reimplemented `serverOwned = !!child || transition` or used a test-local
`spawnServer` wrapper instead of importing production wiring, so deleting the
production line still left them green. The fix shape was to move even tiny
invariants into `createServerAdapter` in `server-host.mjs`: `setPort(onPort)`
happens before `host.start`, `replace` forwards `getPort()`, and `main.mjs`
shrinks to one-line bindings such as `const spawnServer = (p, d) =>
serverAdapter.spawnServer(p, d)`.

The durable fix shape is to extract the composition itself behind injectable
dependencies, leaving the shell entry point thin. For the desktop terminal,
that means a renderer module such as `renderer/terminal-tab.mjs` owns the
lifecycle + xterm + preload bridge + banner + observer wiring, while tests pass
`desk`, `term`, and `observe` doubles and assert the ordering log directly:

- close during pending open records `open`, `closePty:<id>`, and
  `term.dispose`, with no setup entries at all;
- live open records the full setup inside the lifecycle `onReady` callback,
  then teardown disposes exactly the resources setup created.

Before claiming a regression test, hand-mutate the fix out: comment or delete
the guard, preflight, or ordering change, then run the new tests. They must go
red. If they stay green, the test is documentation rather than protection. Do
this especially when a review finding says "X must happen before Y" or "guard G
must exist"; those are easy to test vacuously at the wrong layer.

Rule: when a review finding says "X happens in the wrong order in file F", the
regression must execute F's code or an extraction of it. Testing only a helper F
calls proves the helper, not the composition that misordered it. Corollary: code
that cannot be extracted into a testable unit is where ordering bugs will keep
hiding; extraction is part of the fix, not just test enablement.

For Electron main-process composition roots, if a review finding names a line in
`main.mjs`, the fix is not only that line. Move the invariant into a module the
tests import, and leave the composition root with bindings so trivial that
reverting them breaks an import rather than preserving a silent reimplementation.

This complements the [async lifecycle lesson](/lessons/async-mount-close-race.md): the
lifecycle primitive can be correct while its caller still violates the ownership
boundary around `await start()`.
