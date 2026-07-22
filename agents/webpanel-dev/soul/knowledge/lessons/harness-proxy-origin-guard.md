---
type: Lesson
title: Harness proxy must guard origins, not launder them
description: A dev proxy in front of oas-web must enforce the loopback Host/Origin guard at its own boundary and forward the browser's real Origin rather than rewriting it to a trusted loopback value.
tags: [oas-web, security, dns-rebinding, harness, proxy, desktop-app]
timestamp: 2026-07-22
---

# Security invariant

A proxy placed in front of a loopback-guarded `oas-web` server inherits the
same boundary obligation as the upstream server: reject non-loopback `Host` and
`Origin` values before forwarding POSTs.

# Failure mode

The first desktop renderer `harness-server.mjs` implementation rewrote both
`Host` and `Origin` to the upstream API's loopback authority so proxied POSTs
would pass `oas-web`'s origin guard. Review `7fbab1a` flagged this as a
blocker: a DNS-rebinding page could POST through the proxy to `/api/keys`,
`/api/spawn`, `/api/interrupt`, or other guarded endpoints, while the upstream
server would only see the forged trusted origin.

# Fix pattern

At the proxy boundary, apply the same loopback predicate used by `oas-web`:
loopback hostnames only, and malformed origins return 403. When forwarding to
the upstream API, preserve the browser's real `Origin` header and rewrite only
`Host` for routing.

# Harness-masked integration seams

The same review caught desktop renderer seams that the harness can mask:

- View modules must use `.mjs` filenames; the shell host imports
  `./views/<name>.mjs`.
- `ensureTheme`'s fallback resolves `../theme.css` relative to `views/`.
- `apiJson` must tolerate both a Fetch `Response` object from the harness and
  shell-parsed JSON from the desktop shell's `ctx.api`.
- Keep regressions in `tests/desktop-views.test.mjs` outside the harness,
  because the harness preloads CSS and supplies a Response-shaped API.

# Related concepts

- [Desktop renderer views port of the panel](/architecture/desktop-renderer-views-port.md)
- [Raw key passthrough and the POST host/origin guard](/architecture/raw-key-passthrough-and-host-guard.md)
