---
type: Lesson
title: Copilot-proxied models fail mid-session — plan for auth death, not just spawn-time fallback
description: Copilot-proxied model preference fallbacks resolve at spawn, so mid-session OAuth, proxy, or API-key failures can kill long-running sessions and leave panel sends unsurfaced.
tags: [copilot, auth, resilience, model-fallback, panel]
timestamp: 2026-07-21
---

Same-day incident cluster with github-copilot-proxied models:

1. **cli-dev-1 death**: `OAuth refresh failed for github-copilot` mid-session
   after ~1h of work. The instance had completed its implementation and review
   loop but died before opening its PR. Work survived on its branch (worktree
   mode earned its keep); the maintainer recovered by opening the PR from the
   corpse's branch.
2. **421 Misdirected Request** on session compaction — large summarization
   payload through the proxy on a stale connection; retry/model-switch clears it.
3. **No API key for provider** — a web-panel message was typed into the
   session (delivery worked) but pi could not call the model, so the turn
   evaporated with an error the panel never surfaced.

Lessons:
- Model preference lists (v0.16.0) resolve ONLY at spawn. A mid-session auth
  death has no fallback path — the instance just dies or stalls. For
  high-stakes long runners, consider putting the native provider first, or a
  future adapter-level mid-session failover.
- Fresh short-lived agents (reviewer) are naturally resilient — respawn is
  cheap. Long-lived developers are the exposure.
- Panel gap: sends are fire-and-forget; the transcript poller could detect a
  trailing provider error and show "agent errored after your message"
  (queued as a webpanel-dev task).
- Instance/window drift: a human manually restarting a session in another
  tmux window silently breaks the panel's send routing (it targets the
  recorded window). Doctor-detectable in principle.
