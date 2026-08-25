---
type: Lesson
title: Agent discovery, addressability, and execution are distinct states
description: Attached-agent lineage controls OAS discovery, while aweb roster presence proves addressability rather than task execution.
tags:
  - coordination
  - attached-agents
  - aweb
  - runtime-health
---

# Agent discovery, addressability, and execution are distinct states

An attached agent appears in OAS lineage beneath the owner of its worktree, not beneath the coordinator that assigned or resumed the work. Cross-repository discovery also follows the configured workspace team boundary, so a status command scoped to one sibling repository can omit live attached agents elsewhere. Query the workspace team scope explicitly, for example:

```bash
oas status --team --dir <workspace-team-root>
```

The aweb roster answers a different question. A visible identity or terminal window proves that the agent is addressable, but the session can still be blocked on an interactive folder, channel, or trust prompt. Report health using separate states:

- **Present/addressable**: the identity and window are visible.
- **Executing**: specialist progress or exact-pane evidence shows the brief is running.
- **Blocked**: a prompt, tool failure, or unanswered interaction prevents work.

Do not infer execution from roster presence. When expected progress is absent, inspect the exact pane or obtain an explicit progress report and escalate prompt-blocked sessions immediately.
