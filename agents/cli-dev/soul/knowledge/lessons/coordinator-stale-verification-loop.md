---
type: Lesson
title: Break stale-verification loops with commit-anchored evidence
description: When a coordinator repeatedly verifies stale commits and demands already-landed work, answer with branch-head, ancestry, and blob-level evidence plus explicit ACKs for the named mails.
tags: [coordination, aweb, git, process]
timestamp: 2026-07-26
---

# Lesson

Five consecutive coordinator mails demanded work that was already pushed, each
verified against a different stale commit. Restating "it's done" did not break
the loop; the effective pattern was to anchor the reply to evidence the other
side can reproduce against the current branch head.

Use the soul skill `stale-verification-loop` when a coordinator or reviewer
keeps re-checking old commits and asking for already-landed work.

Key details from the observed loop:

- include `git ls-remote origin <branch>` for the current head SHA;
- use `git merge-base --is-ancestor <claimed-commit> origin/<branch>` to show
  the stale commit is in the branch history;
- use `git show origin/<branch>:<file> | grep -c <pattern>` so evidence is
  pinned to the exact blob the coordinator can reproduce;
- when grepping for removed features, distinguish negation mentions such as
  "There is NO public X" from live surface;
- name the exact re-verification command for the other side;
- invite a file@head quote for anything still missing;
- keep explicitly ACKing the mails the coordinator names each round, because
  their loop detector keys on ACK references rather than delivery state.
