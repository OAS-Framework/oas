---
type: Lesson
title: Keep roster collection out of the serving process
description: The panel's key latency tail came from synchronous collectControlPane work blocking the single-threaded server, so /api/panel and findInstance should serve from a background child-process snapshot instead of collecting inline on request paths.
tags: [desktop-backend, performance, event-loop, latency]
timestamp: 2026-07-23
---

# What made typing spiky

After echo-path tuning, median key latency looked fine but the human still felt
lag. The tail came from the single-threaded Node server: `/api/panel` roster
polls, plus instance-registry TTL rebuilds, synchronously ran
`collectControlPane` across all agent roots. On the lfx+oas deployment that work
included `git status` calls and took about 300-600ms. A key POST arriving during
one of those polls queued behind it: measured key latency was about 6ms alone vs
about 639ms during a panel poll.

The background snapshot also means a just-spawned instance can exist before the
panel roster can resolve it by name; post-spawn follow-up actions need the wait
pattern in [Wait for the roster snapshot before post-spawn instance actions](/lessons/post-spawn-roster-snapshot-lag.md).

# Fix pattern

The serving process should not perform slow roster collection on live request
paths. `oas-web.mjs collect` runs the collection in a child process; the server
refreshes an in-memory snapshot every 3s, skipping a refresh when one is already
in flight. `/api/panel` and `findInstance` read from that snapshot. Cold start
still collects inline once so the first response has data.

After moving collection out of the serving path, key POSTs stayed around 6ms
even concurrent with panel polls, and `/api/panel` served in about 3ms.

# Rules

- On the single-threaded server, any synchronous slow path taxes every other
  endpoint. Audit periodic handlers for `exec*Sync` before tuning the hot path
  itself.
- Benchmark p99 or concurrent-load latency, not just solo medians. If humans
  still report lag after median improvements, look for tail latency.

# Related concepts

- [desktop backend architecture](/architecture/desktop-backend-architecture.md)
- [Fast attach needs cached instance lookup and staged terminal paint](/lessons/fast-attach-cache-tail-backfill.md)
