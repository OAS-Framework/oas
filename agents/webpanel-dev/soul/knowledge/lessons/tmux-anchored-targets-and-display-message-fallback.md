---
type: Lesson
title: Anchor tmux targets and avoid display-message for fail-closed reads
description: tmux `-t` prefix-matches unanchored targets, so oas-web builds validated `=session:=window` targets and uses `list-panes` rather than `display-message` when a missing pane must fail closed.
tags: [oas-web, tmux, security, gotcha]
timestamp: 2026-07-23
---

# Hazards

Two tmux target behaviors matter for oas-web security-sensitive pane reads and
writes:

1. `tmux -t session:window` can match by prefix. During the panel's stale roster
   window, an exited target such as `reviewer-1` could match a live similarly
   named window such as `reviewer-15...`, exposing that pane to capture or
   `send-keys`/interrupt operations.
2. `tmux display-message -p -t <missing-anchored-target>` does not fail closed:
   it can exit 0 and print values from a default context instead of erroring on
   the missing target.

# Safe target pattern

All oas-web tmux targets should be built through the validated target helper
(`OASWEB_TMUXTGT` marker block in the server, same pattern as
`packages/desktop/tmux-target.mjs`). The helper validates session and window
components against `/^[\w@%.-]+$/`, rejecting `:` separators and `=` anchor
injection, then returns `=session:=window`.

With that exact-match form, absent targets should error for `capture-pane`,
`list-panes`, `send-keys`, and interrupt paths instead of matching a similarly
named live window; the exact live name still works.

# Fail-closed reads

An anchored target alone is not enough when the tmux subcommand falls back to a
default context. For pane metadata, `paneInfo` must use `list-panes -t <target>
-F ...`, which errors on a missing window, rather than `display-message -p -t
<target>`.

Any future tmux read path where fail-closed behavior matters should prefer
subcommands with missing-target errors, such as `list-panes` or `capture-pane`,
over `display-message`.

# Regression shape

The regression should prove the hazard against a real tmux server: create a
live `reviewer-15abc` target while `reviewer-1` is absent, show that the
unanchored form prefix-matches, and then assert anchored
`capture-pane`/`list-panes`/`send-keys`/interrupt operations throw for the
absent name while the exact name still succeeds.

# Related concepts

- Key delivery and terminal writes are summarized in
  [Raw key passthrough and the loopback Host/Origin guards](/architecture/raw-key-passthrough-and-host-guard.md).
- Pane metadata lookup appears in the attach path described by
  [Fast attach needs cached instance lookup and staged terminal paint](/lessons/fast-attach-cache-tail-backfill.md).
