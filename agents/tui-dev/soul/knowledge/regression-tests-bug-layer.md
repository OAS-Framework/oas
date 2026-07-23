---
type: Lesson
title: Regression tests must exercise the layer that had the bug
description: A regression test only pins a bug if it executes the code layer whose ordering or composition was wrong; extract that layer behind injectable dependencies instead of testing only a helper it calls.
tags: [testing, regression, desktop, composition]
timestamp: 2026-07-23
---

A reviewer found a terminal ordering regression test that exercised
`createTermLifecycle`, even though the buggy change lived in the caller's
composition code in `shell.mjs`. The test therefore also passed against the
parent commit where setup happened after `await start()`, so it pinned the
helper but not the bug.

The durable fix shape is to extract the composition itself behind injectable
dependencies, leaving the shell entry point thin. For the desktop terminal,
that means a renderer module such as `renderer/terminal-tab.mjs` owns the
lifecycle + xterm + preload bridge + banner + observer wiring, while tests pass
`desk`, `term`, and `observe` doubles and assert the ordering log directly:

- close during pending open records `open`, `closePty:<id>`, and
  `term.dispose`, with no setup entries at all;
- live open records the full setup inside the lifecycle `onReady` callback,
  then teardown disposes exactly the resources setup created.

Rule: when a review finding says "X happens in the wrong order in file F", the
regression must execute F's code or an extraction of it. Testing only a helper F
calls proves the helper, not the composition that misordered it. Corollary: code
that cannot be extracted into a testable unit is where ordering bugs will keep
hiding; extraction is part of the fix, not just test enablement.

This complements the [async lifecycle lesson](async-mount-close-race.md): the
lifecycle primitive can be correct while its caller still violates the ownership
boundary around `await start()`.
