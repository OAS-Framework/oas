---
type: Lesson
title: Race-guard tests must overlap generations and fail when the guard is weakened
description: Request-generation guard tests must keep two in-flight generations alive, resolve newer before older, and mutation-check that removing the generation comparison fails; sequential or dispose-only coverage proves only the disposal half of the guard.
tags: [desktop-backend, desktop, diff-viewer, race-condition, testing, generation-token, review-lesson]
timestamp: 2026-07-23
---

# The trap

A request-generation guard test can pass without testing the generation guard.
The diff view's first regression test resolved each request before starting the
next and only left a request pending across `dispose`; deleting the
`gen === renderGen` comparison still passed because the `mounts.has(dispose)`
half of `owns()` carried the case.

# Reliable regression shape

1. **Create genuinely overlapping generations**: retain a DOM reference to the
   toggle before the loading screen detaches it. Clicking a detached node still
   fires its listener, matching rapid staged/worktree toggle behavior, so two
   clicks create two concurrent in-flight requests.
2. **Resolve in reverse order**: resolve the newest request first and the
   older request last; assert the stale payload never renders and the newer
   payload survives.
3. **Verify by mutation**: temporarily weaken the guard by removing only the
   generation comparison while keeping the disposal check; the test must fail.
   A race test that survives its own guard's removal tests nothing.
4. **Keep disposal separate**: post-dispose completion coverage belongs in a
   separate test, because it proves the other half of `owns()` rather than the
   request-generation race.

# Related

This is the UI-test counterpart to the broader async stale-result pattern in
[Workspace-sensitive async results need local tickets and global workspace generations](/lessons/stale-response-race.md).
