---
type: Lesson
title: Command-running routes must be POST + coalesced
description: GET routes on the loopback desktop server that run child processes on cache miss bypass POST-only Origin guards and let hostile pages fan out process work; make them POST and coalesce concurrent misses behind one in-flight promise.
tags: [desktop, security, server, csrf, child-process]
timestamp: 2026-07-27
---

# The trap

Review `9b1e3ff` flagged the first `/api/models` shape as a GET route that ran
`pi --list-models` (and possibly a login shell) on every cache miss. The
bundled server's CSRF Origin guard only covered POST, and GETs are reachable
from hostile pages through `no-cors` requests against the fixed loopback port.
Before the cache warms, N parallel requests can become N child processes, each
with its own timeout.

A GET handler with its own Origin check is not enough: `no-cors` GET requests
can omit `Origin`, and a loopback `Host` can still be valid when the target is
`127.0.0.1`.

# Durable rule

Any loopback desktop route that can run a command, launch a login shell, or
otherwise allocate child-process work on cache miss must be modeled as a POST so
the existing Origin guard applies. Treat command-running GETs as CSRF fan-out
surfaces even when the route only reads catalog data.

Also coalesce concurrent cache misses behind one in-flight promise:

```js
let inflight = null
if (!inflight) inflight = probe().finally(() => { inflight = null })
return inflight
```

The route-level CSRF guard prevents hostile pages from triggering the work; the
in-flight promise prevents trusted concurrent requests from multiplying the same
child process.

# Regression pattern

Use a counting fake binary for the probe command. Burst several concurrent
requests while the cache is cold and assert exactly one recorded command run;
then assert every response receives the shared result. Keep separate behavioral
security tests at the HTTP boundary rather than source-grep checks.

# Related

- [Raw key passthrough and the loopback Host/Origin guards](/architecture/raw-key-passthrough-and-host-guard.md)
- [Loopback Host guard must cover GET file-serving APIs too](/lessons/loopback-host-guard-all-requests.md)
- [Security regressions must exercise behavior, not source strings](/lessons/behavioral-security-regressions.md)
