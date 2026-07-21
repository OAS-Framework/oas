---
type: Lesson
title: Reviewer capability agent stalls can leave recoverable findings in session logs
description: A reviewer spawned with attached work may stall after reading the diff while oas still reports it idle, and the only recoverable findings may be in the pi session jsonl thinking blocks.
tags: [review, sessions, operations, errors]
timestamp: 2026-07-21
---

On 2026-07-21, three consecutive `oas spawn reviewer --work attached` runs
against `tui/session-error-surfacing` stalled with the same pattern: the
reviewer read its skills, confirmed the review range, read the diff, then its
session jsonl froze on `toolResult` entries with no assistant continuation.
The reviewer's tmux window disappeared from `pi-agents`, while `oas status`
still listed the instance as idle. It produced no `review-report.md`, mail, or
retirement.

The useful workaround was to mine the reviewer's pi session log directly:
`~/.pi/agent/sessions/--<home>--/*.jsonl`, especially assistant `thinking`
blocks. In this case, in-flight findings were recoverable; the reviewer had
already spotted control-character and newline injection in error text, which
led to the `tidyError` fix before re-review.

Important limitation for Control Pane error surfacing: tail inspection cannot
distinguish this stall from a healthy idle session when the final parseable
message is normal. The current `sessionTail` classification correctly reports
`"ok"` for this failure mode because there is no final `stopReason: "error"`.
This limitation should not be papered over in the TUI without a separate
liveness signal. See
[Session-tail classification — final relevant message wins](session-tail-classification-final-message-wins.md).

Open question for the CLI/runtime maintainer: why does the reviewer's pi
session die silently without a `stopReason: "error"` entry?
