---
type: Lesson
title: Usage output must not resolve deployment state
description: `oas help` and similar explanatory commands must bypass capability dispatch and config-chain lock reads so a broken deployment can still print usage and diagnostics.
tags: [cli, help, fail-closed, diagnosability]
timestamp: 2026-07-29
---

# Failure mode

The CLI dispatches unknown words to active capability namespaces so commands
such as `oas okf harvest` can work. That capability dispatch resolves the config
chain and reads every visible lock before it can know which namespaces are
active.

`help` was treated as one of those unknown words. A deployment with a lock the
kernel refused to interpret — including an ancestor or laptop-level lock in the
config chain — could not run `oas help`; it failed during capability discovery
instead of printing static usage.

The failure is especially harmful because help is what operators reach for when
the deployment is already broken. It can also stay invisible in isolated CI
fixtures and reproduce only on a real machine whose home-level scope contains a
superseded lock shape.

# Rule

Anything whose job is to explain the tool must be reachable when deployment
state is unusable. Usage, help aliases, `--version`, and diagnostics that name
what is wrong should either bypass deployment resolution entirely or catch and
report resolution failures as findings. `oas doctor` follows the latter model by
turning fail-closed reads into diagnostics rather than propagating them as the
command result.

For `oas help`, exclude help words from capability dispatch and from JSON
unknown-command routing so they fall through to the static usage text before any
lock read.

# Guard gotcha

Do not add a standalone branch that consumes the help case while intending to
fall through:

```js
else if (HELP_WORDS.has(cmd)) { /* falls through to usage */ }
```

That branch exits the chain with no output and status 0. Put the help condition
on the branch being skipped, or return the usage text explicitly. This is a
non-JSON companion to the broader [dispatcher boundary lesson](/lessons/json-envelope-dispatch-boundary.md): explanatory surfaces need their boundary before fallible deployment discovery.
