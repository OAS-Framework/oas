---
type: Lesson
title: tmux target prefix matching can kill foreign windows
description: tmux `-t session:window` targets prefix-match unless anchored with `=`; exact `=<session>:=<window>` targets and nonexistent test sessions prevent retire tests from killing live siblings.
tags: [tmux, incident, retire, kill-window, core]
timestamp: 2026-07-23
---

# Lesson: tmux target names are prefix-matched

## Incident

Three consecutive `reviewer-15c135c*` instances died 60–90s into their
review: their tmux window in session `pi-agents` vanished mid-turn, session
log cut off abruptly with no error. A fourth (`reviewer-10c67f0`, different
spawner) died the same way earlier.

## Root cause

`tmux kill-window -t pi-agents:reviewer-1` does **fnmatch/prefix matching**
on window names (tmux 3.6b confirmed empirically): with no exact
`reviewer-1` window present, it matched and killed `reviewer-15c135c`,
`reviewer-15c135c-r2`, etc.

The trigger: the repo test suite (`test/capabilities.test.mjs`) calls
`retireInstance(root, "reviewer-1", {})` (and `coord-1`, `checker-1`)
against the **default** tmux session `pi-agents`. `retireInstance` in
`lib/core.mjs` runs `tmux kill-window -t <session>:<name>` for non-self
retires. The reviewer itself runs `npm test` inside its own tmux window
named `reviewer-<sha>` — the test fixture's retire of "reviewer-1"
prefix-matched the reviewer's own live window and killed it. The reviewer's
test run murdered the reviewer. Timing (~60–90s in = when the suite reaches
that test) and the cross-spawner recurrence both fit.

## Fix

- `lib/core.mjs retireInstance`: anchor both kill-window targets with `=`
  (`tmux kill-window -t '=<session>:=<name>'`) — exact match only, in both
  the foreign-kill and detached self-kill paths.
- `test/capabilities.test.mjs`: pass `{ tmuxSession: "oas-test-nosuch" }` to
  every `retireInstance` call so tests never touch the real `pi-agents`
  session at all.

## General rule

Any `tmux` command with a `-t session:window` target that must not affect
similarly-named siblings needs the `=` exact-match prefix on both parts.
Tests that exercise spawn/retire paths must always override the tmux
session to a nonexistent name.
