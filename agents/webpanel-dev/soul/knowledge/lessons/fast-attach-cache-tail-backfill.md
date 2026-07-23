---
type: Lesson
title: Fast attach needs cached instance lookup and staged terminal paint
description: Attach latency is dominated by rebuilding the control-pane registry and serial tmux round trips, so keep a short registry cache, merge pane metadata queries, paint a cached or short tail first, and deep-backfill later with the requested line count in the render signature.
tags: [oas-web, performance, attach, tmux]
timestamp: 2026-07-23
---

# What made attach slow

Attaching to a session can feel slow even when terminal rendering is not the
bottleneck. In the measured slow path, `findInstance()` rebuilt the whole
control-pane model (`collectControlPane` per agent root) on every
`/api/session` request. On the lfx deployment with 7 team roots that cost about
300ms per request, at a 500ms poll cadence.

The fix is a short instance-registry TTL cache: roster changes happen on
spawn/retire, so a 2.5s cache avoids repeated control-pane rebuilds without
making normal attach behavior stale in a meaningful way.

The other server-side round-trip was tmux metadata: two serial metadata queries
for pane size and history size were merged into one `paneInfo()` call. When that
lookup must fail closed for a missing target, `paneInfo()` should use
`list-panes` rather than `display-message`, because `display-message` can fall
back to a default context even with an anchored target; see
[Anchor tmux targets and avoid display-message for fail-closed reads](/lessons/tmux-anchored-targets-and-display-message-fallback.md).
The in-browser parse of a 2000-line ANSI capture measured around 50ms, so it was
not the dominant attach cost.

# Fast attach pattern

`setPaneSession` should make the first paint cheap and then fill in depth:

1. Paint the cached last frame immediately, with zero tmux round-trips, when the
   session was viewed before. The `frameCache` is refreshed on every successful
   fetch.
2. Fetch a short tail, about 120 lines, so the pane becomes live and interactive
   after a cheap capture.
3. Backfill the deep 2000-line scrollback in the background. Keep the backfill
   generation-guarded so switching panes mid-backfill cannot cross-paint into
   the new pane.

The render signature must include the requested `lines` value. Otherwise the
short-tail paint can suppress the later deep-backfill paint because both
responses look like the same frame.

# Observed effect

The measured warm `/api/session` path dropped from about 165ms to 23ms for a
2000-line capture and 13ms for a tail capture. Re-attaching a viewed session can
paint synchronously from cache, so perceived attach is near 0ms; cold attach is
roughly one tail round-trip before the pane is usable.

# Related concepts

- The server/UI shape and polling model are summarized in
  [oas-web architecture](/architecture/oas-web-architecture.md).
- Per-pane session state and stale-response guards live in
  [Split panes, collapsible sidebar, and compact session header](/architecture/split-panes-and-compact-shell.md).
- Tmux target anchoring and `display-message` fallback behavior are covered in
  [Anchor tmux targets and avoid display-message for fail-closed reads](/lessons/tmux-anchored-targets-and-display-message-fallback.md).
