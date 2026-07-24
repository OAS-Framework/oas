---
type: Lesson
title: WHATWG URL resolution is an SSRF footgun in privileged proxies
description: new URL(path, base) resolves protocol-relative ("//host/x") and backslash ("/\\host/x") inputs to a different origin, so a privileged fetch proxy must check url.origin against the base origin, not just require a leading slash.
tags: [security, url, ssrf, electron, desktop]
timestamp: 2026-07-22
---

Found by `reviewer-de5141c` on the desktop app's IPC API proxy: the input
check "must start with `/`" passed `//attacker.example/x`, and
`new URL(that, "http://127.0.0.1:4820")` resolved it to
`http://attacker.example/x`; the privileged main process would fetch an
arbitrary host, bypassing renderer CSP and the loopback boundary. WHATWG URL
also normalizes backslashes, so `/\attacker.example/x` behaves the same.

Fix pattern (`packages/desktop/api-url.mjs`): resolve, then assert
`url.origin === new URL(base).origin` — checking the output, not trying to
enumerate bad input shapes. Companion pin: on shared multi-workspace servers,
force-set (`searchParams.set`) the verified `ws` id on scoped endpoints;
only-set-when-absent still lets callers pick another workspace.

Testability bonus: extracting the shaping into a pure Electron-free module
lets the root `node --test` gate carry the regression tests
(`test/desktop-api-url.test.mjs`).

Related: [Electron desktop shell hardening review lessons](desktop-shell-hardening-review-lessons.md).
