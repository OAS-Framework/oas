---
type: Lesson
title: Pi strict curriculum needs --no-extensions, not just --no-skills
description: Extension resources_discover hooks inject skill paths that survive --no-skills, so pi's fail-closed launch must disable extension discovery and re-add selected extensions with -e.
tags: [pi, runtime, skills, strict-curriculum, isolation]
timestamp: 2026-07-27
---

# Lesson

Verified against **pi 0.80.10** with canaries planted at every ambient skill
source: user `~/.agents/skills`, ancestor and project `.agents/skills`, project
`.pi/skills`, npm package skills, and repo `AGENTS.md`/`CLAUDE.md`.

`pi --no-skills --skill <dir>` removes every *discovered* skill and keeps the
explicit one, but it does **not** remove skills contributed by an extension's
`resources_discover` hook. The OAS Pi bridge (`packages/pi/extension/index.ts`)
uses that hook, so `oas-getting-started` still appeared under `--no-skills`.
Any installed third-party extension can leak skills the same way.

The fail-closed launch is therefore:

```bash
pi --no-skills --skill <home>/.agents/skills \
   --no-extensions -e <each selected extension> \
   --no-context-files --no-prompt-templates \
   --append-system-prompt <home>/AGENTS.md \
   --approve --name <instance> @TASK.md
```

Confirmed properties:

- `--skill` is additive even with `--no-skills`.
- `-e` works under `--no-extensions`.
- Both behaviors are documented in pi's `docs/skills.md` and were observed in
  the runtime.
- `--no-context-files` also suppresses the instance's **own** composed
  `AGENTS.md`, so OAS must deliver it explicitly. `--append-system-prompt
  <file>` reads the file contents into the system prompt, verified by canary.
- The repository's `./work/AGENTS.md` remains readable by the `read` tool but is
  not auto-injected, which is the intended "readable, not auto-loaded" contract.
- Built-in tools (`read`, `bash`, `edit`, `write`) survive the strict launch.

Gotcha: `--no-tools` suppresses the skill listing entirely because skills are
surfaced through the tool layer. Never combine `--no-tools` with a strict launch
or with a probe meant to enumerate skills.

# Related

Do not turn this launch line on in production until [runtime extensions are
capability resources](/lessons/pi-strict-launch-blocked-on-runtime-extensions.md):
without a capability-declared Pi extension resource, `--no-extensions` would
disable aweb messaging.

See [Claude Code strict launch uses --setting-sources](/lessons/claude-strict-launch-setting-sources.md)
for the corresponding Claude runtime isolation rule. The governing release gate
is in [strict curriculum scoping](/references/strict-curriculum-scoping.md): an
instantiated soul receives only the curated active-capability curriculum, with
selected resources materialized and proven in the real runtime.
