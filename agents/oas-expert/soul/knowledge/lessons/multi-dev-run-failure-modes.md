---
type: Lesson
title: Multi-agent runs need exact messaging and reviewer protocols
description: The first coordinator-plus-developers run showed that agents sleep-poll live aweb channels, guess CLI flags, misread unread inboxes, and lose fresh-eyes review unless injections give exact commands and reviewer lifecycle rules.
tags: [aweb, coordination, review, injections]
timestamp: 2026-07-21
---

Watching the first coordinator + developers feature run in tmux surfaced
failure modes that were not solved by merely making skills available.
Injections need exact invocations for the few commands agents must run, and
must say when to load the matching skill.

# Observed anti-patterns

- **Sleep-polling with a live channel**: the coordinator ran
  `sleep 300; aw mail inbox` loops for hours despite live aweb awakenings.
  The aweb injection now says never to sleep or poll; go idle and let the
  channel awaken the session.
- **Guessed CLI syntax**: agents tried positional recipients
  (`aw mail send <alias>`) and invented `--reply-to`; the aweb injection now
  carries exact command cribs and says to run `--help` rather than invent
  flags.
- **Inbox semantics confusion**: agents treated an empty `aw mail inbox` as
  lost mail, then built `--show-all --json` parsing workarounds. The
  injection now states that inbox shows unread mail only and that
  `--show-all` is history.
- **Reviewer contradictions**: reviewers wrote report files and tracked
  `STATE.md`; stalled reviewers led developers to review and patch their own
  code, losing the fresh-eyes property. The reviewer role is now ephemeral,
  diff-only, and reports by aweb mail to the spawning parent.
- **Reviewer name collisions**: sequential reviewer names churned through
  retire and respawn. Reviewer names now derive from a short commit SHA via
  `--purpose <short-sha>`.

The team flow recorded in [OAS development team](/decisions/dev-team-and-review-flow.md)
should be read with these failure modes in mind: the protocol is narrow
because loose instructions produced avoidable coordination errors.
