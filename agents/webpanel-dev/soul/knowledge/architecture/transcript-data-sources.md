---
type: Concept
title: Chat transcript data sources — pi and claude session JSONL formats
description: The chat view parses the runtime's own session logs — pi's JSONL under ~/.pi/agent/sessions with a path-derived directory name, claude's under ~/.claude*/projects — and the two formats differ in how tool results are attached (pi uses role=toolResult messages; claude folds tool_result blocks into user messages).
tags: [oas-web, transcript, parseTranscript, sessionFileFor, pi, claude, jsonl]
timestamp: 2026-07-21
---

# Where the files live (`sessionFileFor` in oas-web.mjs)

- **pi**: `~/.pi/agent/sessions/-<instance home with "/" → "-">--/<ts>_<id>.jsonl`.
  The directory name is the instance home path with every `/` replaced by `-`
  (yielding a leading `-` plus the built prefix `-`, i.e. it starts with `--`),
  and a trailing `--`. Example: home `/Users/x/oas/agents/a/instances/a-1`
  → dir `--Users-x-oas-agents-a-instances-a-1--`.
- **claude**: `~/.claude/projects/<cwd with "/" → "-">/<uuid>.jsonl`, also
  probing `.claude-personal` and `.claude-work` config dirs.
- In both cases the panel takes the **newest .jsonl by mtime**. Known caveat
  (deliberate): after a session restart it follows the new file — older
  history is not stitched.

# Line shapes (`parseTranscript`)

Each line is JSON. The envelope differs:

- **pi**: `type === "message"`, payload at `.message` with
  `role: user | assistant | toolResult`. Assistant content blocks:
  `text`, `thinking` (key `thinking`), `toolCall` (`id`, `name`,
  `arguments`). Tool output arrives as a **separate `toolResult` message**
  keyed by `toolCallId`.
- **claude**: `type === "user" | "assistant"`, payload at `.message`.
  Assistant tool blocks are `tool_use` (`id`, `name`, `input`). Tool output
  is **folded into the next user message** as `tool_result` blocks keyed by
  `tool_use_id` — so real user text must be extracted after stripping those.

`parseTranscript` normalizes both into turns
`{ role, text, thinking, tools: [{id, name, args, result}], ts }` using a
`callIndex` map (toolCallId → tool entry) so results attach to their calls
regardless of which envelope delivered them. Results are truncated to 4000
chars. Both content-key variants (`arguments`/`input`, `toolCall`/`tool_use`)
must be handled every time you touch this code.
