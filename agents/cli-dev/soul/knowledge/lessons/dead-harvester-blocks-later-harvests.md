---
type: Lesson
title: A dead harvester silently blocks every later harvest
description: The harvest guard treats an existing memory-harvest instance as a running one, so a harvester whose session exited silently suppressed every later harvest for the rest of the task.
tags: [okf, harvest, memory, liveness, framework-bug]
timestamp: 2026-07-28
---

# Lesson

`oas okf harvest` answered `{"harvestSpawn":"skipped","why":"harvester already running for
this instance"}` on every call for most of a long task. It was telling the truth about the
INSTANCE and nothing about the WORK: the harvester's tmux window was still there while its
session had exited at a shell prompt, so it counted as running forever and 14 notes sat
unpromoted until the task was over.

The guard exists for a good reason — concurrent harvesters on one work tree would collide.
But "an instance exists" is not "a harvester is working". The kernel already knows how to
check liveness properly: `retireInstance` verifies the tmux window is really gone rather
than trusting `kill-window`'s exit code, and the spawn rollback verifies effects rather than
exit codes. The harvest guard should ask the same question.

**A guard that fails closed on a stale signal is an outage that reports success.** Skipping
is the dangerous default here: the call exits 0, prints a reasonable-sounding reason, and
the caller — an agent following its own instructions to harvest after every commit — has no
way to tell "already handled" from "silently doing nothing, forever".

Two practical consequences for anyone hitting this:

- If harvests report "already running" more than once or twice across a session, look at the
  harvester's window. A pane sitting at a shell prompt with no process is a dead harvester.
  `oas retire <harvester-instance>` clears it and the next harvest spawns normally.
- Notes are only safe once promoted. They live in the instance home, and the home is removed
  at retirement — so a harvest that never runs is silent data loss with a delay fuse.
