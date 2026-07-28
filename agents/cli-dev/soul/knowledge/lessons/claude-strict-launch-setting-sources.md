---
type: Lesson
title: Claude Code strict curriculum is --setting-sources "" plus --plugin-dir, never an isolated config home
description: An isolated CLAUDE_CONFIG_DIR breaks authentication, while --setting-sources "" excludes ambient skills, plugins, and CLAUDE.md yet keeps auth, built-ins, and explicitly selected plugins with their MCP servers.
tags: [claude-code, runtime, skills, plugins, strict-curriculum, isolation, auth]
timestamp: 2026-07-27
---

# Lesson

Verified against **Claude Code 2.1.220** with canaries at user skills, project and
ancestor `.claude/skills`, project and ancestor `CLAUDE.md`, `AGENTS.md`, and
seven installed plugins.

## Config-home isolation is the wrong lever

Pointing `CLAUDE_CONFIG_DIR` at a fresh per-instance directory fails with
`Not logged in · Please run /login`. Auth state is bound to the config dir, so
isolating it would force copying credentials into the repo or instance. Reject
that approach.

## The mechanism that works

```bash
claude --setting-sources "" \
       --plugin-dir <composed instance skills as a session-only plugin> \
       --plugin-dir <each selected provider plugin> \
       --settings <file> \
       --append-system-prompt-file <home>/AGENTS.md \
       -- "$(cat TASK.md)"
```

`--setting-sources ""` runs against the deployment's **existing** config dir:
authentication works untouched, while user skills, project skills, **ancestor**
`.claude/skills`, every installed plugin, and both project and ancestor
`CLAUDE.md` all disappear. The 35 bundled provider skills and built-in tools
remain.

Use `--debug-file` output as the reliable oracle, not model self-report:

```text
Found 1 plugins (1 enabled, 0 disabled)
getSkills returning: 0 skill dir commands, 1 plugin skills, 35 bundled skills
MCP server "plugin:aweb-channel:aweb": Starting connection
```

An explicitly selected plugin, including its MCP server such as the aweb channel,
is preserved.

## Rejected alternatives and gotchas

- `--setting-sources project` re-admits **ancestor** `.claude/skills` and both
  `CLAUDE.md` files. It is not fail-closed.
- `--bare` forbids OAuth/keychain auth (`ANTHROPIC_API_KEY`/`apiKeyHelper` only),
  so it silently changes the auth model. Never use it as a fallback.
- `--safe-mode` isolates equivalently but also kills the plugins that selected
  capabilities must keep.
- `--settings <file>` **is** honored under `--setting-sources ""`
  (`Applying permission update … destination 'flagSettings'`), so OAS-owned
  settings survive.
- `--append-system-prompt-file <path>` exists and validates its argument, but is
  **absent from `--help`**. Probe it by invocation, not by help-string match.
- Claude has no "extra skills directory" flag, so the composed set must be
  presented as a session-only plugin. Plugin skills are **namespaced** as
  `<plugin>:<skill>`; literal `/skill-name` references in instructions break.
- Even under `--setting-sources ""`, ancestor settings files are still *watched*
  but not loaded. Keep a regression assertion for that distinction.

# Related

See [Pi strict launch requires --no-extensions](/lessons/pi-strict-launch-requires-no-extensions.md)
for the corresponding Pi runtime isolation rule, and
[strict curriculum scoping](/references/strict-curriculum-scoping.md) for the
release gate this mechanism satisfies.
