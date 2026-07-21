---
type: Lesson
title: Session-tail classification — final relevant message wins
description: classifySessionTail lets the last relevant session-log message decide whether a session is error, ok, or unknown, so a later normal message must override an earlier API error.
tags: [control-pane, model, sessions, errors]
timestamp: 2026-07-21
---

`classifySessionTail(lines, kind)` in `lib/control-pane/model.mjs` scans the
session-log tail and lets the **last relevant entry** decide the state. For pi
logs, a `type:"message"` entry with `message.stopReason === "error"` sets
`state: "error"` and carries an `errorMessage` truncated to 500 characters; any
later normal message overwrites that to `state: "ok"`, because the session
recovered. Claude logs use `isApiErrorMessage` and `error` markers on
`type: "user"` / `type: "assistant"` entries. No parseable relevant message
leaves the state `"unknown"`.

Implementation constraints that matter for future changes:

- Read only the tail, not the whole log. The current code reads about 64 KiB
  with `openSync` / `readSync` at an offset because session logs can grow large
  and `collectControlPane` runs on a 2.5 second refresh loop.
- When the read starts in the middle of a file and yields more than one line,
  drop the first line: it may be a truncated JSON record.
- Swallow every I/O failure and return `"unknown"`; a missing or rotating
  session file must never crash the pane.

Session path encoding differs by runtime:

- pi: `~/.pi/agent/sessions/-<home with / replaced by ->--/` — note the
  leading `-` and trailing `--`.
- Claude: `~/.claude*/projects/<home with / replaced by ->`.

This belongs with the runtime-neutral model layer described in
[Control Pane architecture — model/TUI split and shared data layer](architecture-model-tui-split.md): `sessionTail` is model data consumed by the
terminal pane and potentially other panels, not a TUI-only detail.
