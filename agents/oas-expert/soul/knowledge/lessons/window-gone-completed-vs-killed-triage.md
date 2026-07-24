---
type: Lesson
title: Vanished agent window + no verdict — completed-but-event-dropped vs killed
description: After a subagent's tmux window disappears with no verdict mail event, do not assume it was killed; discriminate completed-but-channel-fault from external kill with `aw mail inbox --show-all` and the session log tail.
tags: [aweb, channel, incident-triage, reviewer, tmux]
timestamp: 2026-07-23
---

# Lesson: window-gone + no-mail-event has two very different causes

## Context

During the reviewer-deaths incident, two reviewers that completed cleanly
(verdict mail sent, clean `oas retire --self`) were initially misdiagnosed as
killed because the visible symptom — tmux window gone with no awakening event
at the spawner — was identical. The aweb channel had verdict mail visible in
history while the spawner's idle session had not been awakened; plain
`aw mail inbox` showed no unread messages.

A later delayed delivery/flush can still make the event arrive; the triage
point is unchanged: absence of a live awakening is not enough to classify the
agent as killed.

## Triage discriminators

When a spawned instance's window vanishes without a verdict event:

1. Run one targeted `aw mail inbox --show-all` from the spawner. If the
   verdict is present, the agent completed and the missing live awakening is a
   channel fault to report.
2. Inspect the session log tail (`~/.pi/agent/sessions/<encoded-home>/*.jsonl`):
   - clean `aw mail send` followed by `oas retire --self` means normal
     self-retirement;
   - abrupt cutoff mid-turn, especially around queued tool calls and with no
     send/retire at the end, means the window was externally killed.

## Channel fault signature

Message present in `--show-all` but absent from the unread inbox, with no
awakening received in the idle recipient session, is a channel delivery fault
in the live push path. Escalate it to the human/channel maintainers. Do not
paper over it with sleep-poll loops; a single targeted `--show-all` check
after observing window disappearance is the acceptable interim workaround.

## Related

- [tmux target prefix matching can kill foreign windows](/lessons/tmux-target-exact-matching.md)
  records the externally-killed path from the same incident.
- Sender self-retirement after sending does not explain missing inbound
  delivery. Replying to a retired local `did:key` sender can fail with local
  resolution/return-route errors, but that is a separate wart.
