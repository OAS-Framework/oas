---
type: Lesson
title: CLI locator tests need hermetic PATH and absolute fixtures
description: Tests that rely on CLI discovery or unavailability must pin every locator source; fake fixtures under hostile PATH need absolute launchers and realpath assertions.
tags: [testing, desktop, fixtures, cli, path]
timestamp: 2026-07-25
---

# No-CLI degradation tests

Tests that assert the desktop server degrades because no compatible `oas` CLI is
available must make that environment true. Developer machines often have
`@oas-framework/oas` globally installed; if the server's CLI locator finds it, a
spawn attempt that was expected to return `503` / `cli-unavailable` can proceed
to the mutation path and fail later with `409` instead.

Spawn those server tests with all locator sources pinned inert — and the PATH
fully hermetic, not just "minimal":

```sh
PATH=/nonexistent
OAS_DESKTOP_OAS_BIN=""
SHELL=/bin/false
```

A "minimal" `PATH=/usr/bin:/bin` is NOT enough: `/usr/bin/npm` remains
reachable, so the locator's independent npm-global source (`npm prefix -g`)
can still rediscover a globally installed `oas` outside PATH (e.g. under
`/usr/local/bin`) — exactly the machine-dependence being eliminated. The
hermetic combination strips the explicit env override, PATH lookup, the
npm-global lookup (npm itself unreachable), and the login-shell fallback.
Any test whose expected result depends on CLI absence should own this
environment instead of inheriting the operator's machine state.

# Fake executable fixtures under hostile PATH

Integration tests for CLI discovery sometimes deliberately set `PATH=/nonexistent`
so only the fake executable fixture is discoverable. A fake binary implemented as
a `#!/usr/bin/env node` script fails in that environment: `/usr/bin/env` consults
the child process PATH and cannot find `node`.

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

- [Spawn endpoint root allowlist and empty-task semantics](/architecture/spawn-endpoint.md)
- [Security regressions must exercise behavior, not source strings](/lessons/behavioral-security-regressions.md)
- [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md)
