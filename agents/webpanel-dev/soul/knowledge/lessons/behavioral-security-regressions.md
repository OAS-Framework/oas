---
type: Lesson
title: Security regressions must exercise behavior, not source strings
description: Guard regressions must drive the real boundary with forged requests and a fake upstream, because source-string checks pass when the guard is inverted, unreachable, or no longer returns 403.
tags: [oas-web, testing, security, regression, harness, proxy]
timestamp: 2026-07-22
---

# Security regressions must exercise behavior, not source strings

A guard regression that greps implementation source for `okHost(host)` or for
the absence of a forged-origin pattern does not prove the boundary still works.
Review `ba85464` flagged this failure mode: string checks still pass when the
condition is inverted, unreachable, or no longer returns 403, and they never
verify that the real `Origin` reaches the upstream side.

# Behavioral test pattern

For the harness proxy origin guard, the durable pattern is to test the boundary
against a fake upstream:

1. Export the server factory (`createHarnessServer(api)`) and keep script mode
   behind a realpath check on `process.argv[1]`.
2. Start the harness server against a fake upstream `node:http` server that
   records incoming requests.
3. Assert hostile `Host`, hostile `Origin`, and malformed `Origin` requests all
   return 403 and leave the upstream `seen` list empty, proving nothing crossed
   the proxy boundary.
4. Assert a loopback request is proxied with its original `Origin` unchanged and
   `Host` rewritten only to the upstream authority.
5. Assert an origin-less request stays origin-less; the proxy must not invent a
   trusted header.

# Forged-header gotcha

Browser-grade `fetch()` silently strips forbidden headers such as `Host` and can
also interfere with `Origin`. Drive forged-header cases with raw
`node:http.request`; otherwise the intended hostile request can arrive clean and
the 403 assertion fails against a legitimate 200.

# Related concepts

- [Harness proxy must guard origins, not launder them](/lessons/harness-proxy-origin-guard.md)
- [Desktop renderer views port of the panel](/architecture/desktop-renderer-views-port.md)
