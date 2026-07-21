---
type: Concept
title: Workflow tool rendering — meta from the script source, final result only
description: The panel renders pi's dynamic-workflows tool calls as a distinct boxed panel by regex-extracting the workflow's meta name and description from the JS script argument, and only the final result is available because per-step live progress is TUI-ephemeral and never reaches the session log.
tags: [oas-web, workflow, rendering, pi, transcript]
timestamp: 2026-07-21
---

# How it works (panel.html)

pi's dynamic-workflows extension emits a tool call named `workflow` whose
argument is a raw JS script beginning with
`export const meta = { name, description }`. There is no structured metadata
in the call, so the panel extracts it from the source:

`workflowMeta(t)` regex-matches the script text for
`meta = { ... name: '<name>' ... }` and likewise for `description:` —
capturing the quoted values with a character-class match over the three
quote styles. See `workflowMeta` in `ui/panel.html` for the exact patterns.

`workflowHtml` renders a distinct boxed panel (like pi's own TUI framing):
workflow name, description, running state while `result === null`, and the
final result once the toolResult lands.

# The limitation to know before "improving" it

Workflow **per-step live progress (phases, subagent labels) is
TUI-ephemeral** — pi paints it live in the terminal but it is never written
to the session JSONL. The transcript only ever contains the tool call
(script) and the final tool result. So the chat view fundamentally cannot
show live workflow phases from the transcript; a running workflow shows as
"running" until it finishes. If live phases are ever wanted, the raw
terminal capture (`/api/session`) is the only data source that has them.
