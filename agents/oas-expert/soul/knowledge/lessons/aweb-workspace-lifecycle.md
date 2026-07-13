---
type: Lesson
title: aweb workspace lifecycle — delete requires staleness, leave needs the key
description: Graceful teardown is `aw workspace delete <name>` run FROM INSIDE the instance (immediate, needs the key); remote deletes require staleness (>4min); deleting the dir first strands the record.
tags: [aweb, lifecycle, retire, gotcha]
timestamp: 2026-07-08
---

Probed on a live hosted aweb team (aw 1.32.5, probe instances).

# Verified

- **Mint**: `aw team invite --json` (from root workspace, returns token) →
  in instance home: `aw team join <token> --name <instance>` →
  `aw init --do-not-touch-agents-md`. Instance appears in team roster,
  self-custodial local identity (`.aw/signing.key`), alias = instance name.
- **Messaging**: `aw mail send --to <human-alias> --subject … --body …` from the
  instance → arrives in the root inbox as `<namespace>/<instance>`. Note:
  recipient flag is `--to` (positional recipient is rejected).
- **Teardown, graceful (verified with probe2)**: `aw workspace delete
  <name>` run **from inside the instance home** (self-delete, authenticated
  by its own `.aw/signing.key`) succeeds **immediately** — removes the
  server record and the local identity, roster clean, no staleness wait.
  `aw team leave` is NOT the path: it refuses for the only team ("cannot
  leave the only team; remove the workspace instead").
- **Teardown, janitorial**: a *remote* `aw workspace delete <name>` (e.g.
  from the root workspace) is guarded by staleness: HTTP 409 "Workspace is
  still active; only stale local workspaces can be deleted" until the
  server has seen heartbeat silence for the staleness window (**>6 min**;
  exact duration unmeasured). Tight retry loops are pointless.
- **Deleting the instance dir first is a mistake**: it destroys
  `.aw/signing.key`, so the instance can never self-delete;
  `aw workspace status` then marks it `gone_local_cleanup_candidate, left
  workspace record intact` and only the janitorial path (post-staleness)
  can clean it.

# Team boundedness (added 2026-07-09)

The minting authority search is BOUNDED: instance home → its git repo root →
context repo (+ its git root) → workspace root. Never walk past the workspace
to the laptop — a `.aw` there is a different team and minting into it is a
silent cross-team leak. Always pass `--team-id` explicitly (config pin, else
the root's active team) and verify the joined cert's team_id; implemented in
packages/oas-aweb/bin/oas-aweb.mjs.

# Retire order (for the oas integration)

1. kill tmux window
2. `aw workspace delete <instance>` **from inside the instance home**
   (immediate, graceful)
3. only then delete the dir
4. fallback if step 2 was skipped/failed: deferred remote
   `aw workspace delete <name>` from the root once stale; tolerate 409 as
   "not stale yet"

The retire order is implemented in the package (retire runs the self-delete
before removing the home); this lesson is the *why*, so nobody "simplifies"
the order away.

# Open questions

- Exact staleness window duration (probe-instance still 409 at ~7 min after
  last heartbeat).
