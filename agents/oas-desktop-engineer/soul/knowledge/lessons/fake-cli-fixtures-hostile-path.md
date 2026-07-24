---
type: Lesson
title: Fake CLI fixtures need absolute-path launchers under hostile PATH
description: Fake CLI fixtures invoked under an emptied PATH should launch Node and fixture logic by absolute path and compare expected executable paths after realpath canonicalization.
tags: [testing, desktop, fixtures, cli, path]
timestamp: 2026-07-24
---

# Fake CLI fixtures need absolute-path launchers under hostile PATH

Integration tests for CLI discovery sometimes deliberately set `PATH=/nonexistent`
so only the fake executable fixture is discoverable. A fake binary implemented as
a `#!/usr/bin/env node` script fails in that environment: `/usr/bin/env` consults
the child process PATH and cannot find `node`.

# Launcher pattern

Write hostile-PATH CLI fixtures as two files:

1. the JavaScript fixture logic; and
2. a `/bin/sh` launcher that executes both Node and the script by absolute path,
   using `process.execPath` captured when the test writes the fixture:

```sh
#!/bin/sh
exec "/absolute/path/to/node" "/absolute/path/to/fixture.js" "$@"
```

This keeps the test's PATH hostile without making the fake executable depend on
that hostile PATH to start.

# Path assertions

When production locators canonicalize candidates via `realpath`, assertions must
compare against `realpathSync(fixture)`, not the raw path returned by `mkdtemp` or
fixture construction. On macOS, temp paths under `/var/folders/...` canonicalize
to `/private/var/folders/...`, so a correct locator can change the path string
identity.

# Invocation assertions

Have the fixture append argv and cwd records as JSONL to a log file. The test can
then assert exact invocation shape without an IPC back-channel: allowlisted argv,
`--task-file` instead of inline task text, and harvest cwd equal to the resolved
instance home.

# Related concepts

- [Security regressions must exercise behavior, not source strings](/lessons/behavioral-security-regressions.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
