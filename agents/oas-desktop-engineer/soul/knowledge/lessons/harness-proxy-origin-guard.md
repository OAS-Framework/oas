---
type: Lesson
title: Harness proxy must guard origins, not launder them
description: A dev or harness proxy in front of oas-web must enforce the loopback Host/Origin guard at its own boundary before serving static files or proxying, and forward the browser's real Origin rather than rewriting it.
tags: [desktop-backend, security, dns-rebinding, harness, proxy, desktop-app]
timestamp: 2026-07-22
---

# Security invariant

A proxy placed in front of a loopback-guarded `oas-web` server inherits the
same boundary obligation as the upstream server: validate the inbound `Host` as
loopback before any static serving or `/api/*` proxying, and reject non-loopback
or malformed `Origin` values before forwarding POSTs.

# Failure mode

The first desktop renderer `harness-server.mjs` implementation rewrote both
`Host` and `Origin` to the upstream API's loopback authority so proxied POSTs
would pass `oas-web`'s origin guard. Review `7fbab1a` flagged this as a
blocker: a DNS-rebinding page could POST through the proxy to `/api/keys`,
`/api/spawn`, `/api/interrupt`, or other guarded endpoints, while the upstream
server would only see the forged trusted origin.

A later `dev-serve.mjs` shape had the same boundary bug for `Host`: by rewriting
upstream `Host` to a loopback authority without first validating the inbound
`Host`, it let arbitrary DNS-rebound requests reach guarded APIs through the dev
port.

# Fix pattern

At the proxy boundary, apply the same loopback predicate used by `oas-web` to
the inbound `Host` before deciding whether to serve a static file or proxy an
API request. For POSTs, malformed or non-loopback origins return 403. When
forwarding to the upstream API, preserve the browser's real `Origin` header and
rewrite only `Host` for routing after the proxy has accepted the inbound host.

Do not normalize hosts with a naive `:\d+$` port-strip: it mangles bare IPv6
loopback hosts such as `::1`. Special-case bare IPv6 loopback before stripping a
port.

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
