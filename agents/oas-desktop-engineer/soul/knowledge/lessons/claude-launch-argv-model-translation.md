---
type: Lesson
title: Claude launch argv needs option terminator and runtime model translation
description: Claude spawns can fail silently if hook-contributed variadic flags consume the TASK.md prompt or pi-style provider/model preferences reach the claude runtime, so launch commands must insert `--` before the prompt and translate/drop unsupported model entries.
tags: [kernel, claude, spawn, launch, model-selection]
---

# Failure shape

Claude-runtime spawns that look stuck in the desktop app may have exited before the session starts. One observed case dropped into the fallback shell behind a blank tmux pane; scrollback contained `entries must be tagged: <task text>`.

The cause was launch argument parsing, not tmux readiness: the aweb launch hook contributed `--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace`, and that claude flag is variadic. Without an option terminator, it swallowed the following positional prompt argument (`"$(cat TASK.md)"`) as another channel entry.

# Launch argv contract

The kernel claude command line must terminate option parsing after hook-contributed args and before the prompt:

```sh
... ${hookArgs} -- "$(cat TASK.md)"
```

Regression coverage should pin the persisted command shape, including the separator before the prompt, not only the presence of hook args; the diagnosed fix pinned a pattern like `/--extra-flag -- "\$\(cat TASK\.md\)"/`.

# Claude model preference translation

The desktop [spawn endpoint](/architecture/spawn-endpoint.md) should continue treating model input as free text, but the claude runtime cannot consume every pi-style provider/model pattern. Passing a preference such as `github-copilot/claude-fable-5:high` through to claude produced a launch-time "issue with the selected model" failure.

For runtime `claude`, `resolveModelPreference` should choose the first usable entry after runtime-specific translation:

- `anthropic/<id>[:thinking]` becomes the bare claude model id.
- Aliases and already-bare ids pass through.
- Entries for other providers are dropped.
- If no usable entry remains, return `""` and let claude choose its own default.

This complements the [advisory model-selection UI lesson](/lessons/model-selection-advisory-datalist.md): the UI and `/api/spawn` do not validate catalog membership, but the runtime launcher still has to translate or omit preferences that the target runtime cannot parse.

# Workspace-level claude binary override

`oas-claude-config` is a closest-first config file whose one line names the claude binary to launch, such as `claude-personal`. Putting it at a workspace root makes all claude spawns in that deployment use that account-specific binary. It is personal machine config by contract and belongs in `.gitignore`.

# Debugging technique

When a claude spawn appears stuck, reproduce the exact argv outside tmux with `claude --print <same argv>`. Prompt parsing and model-selection errors surface immediately there instead of being hidden behind the fallback shell.
