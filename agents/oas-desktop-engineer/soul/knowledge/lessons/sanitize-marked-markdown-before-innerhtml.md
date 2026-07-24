---
type: Lesson
title: Sanitize and normalize markdown anchors before innerHTML
description: DOMPurify decides what untrusted markdown markup survives, but surviving anchors still need a post-sanitize pass that rewrites local file links and forces safe target/rel on external links before innerHTML.
tags: [desktop-backend, desktop-viewers, markdown, security, xss, dompurify]
timestamp: 2026-07-22
---

# The trap

Markdown files opened in desktop viewers are untrusted input. Running them through `marked` is not a sanitizer: `marked` preserves raw HTML, and assigning that output to `innerHTML` can execute hostile markup.

A first fix can still be unsafe if it only adds DOMPurify with `ADD_ATTR: ["target"]` and sets safe `target`/`rel` values in `marked`'s link renderer. Raw HTML anchors in the markdown, such as `<a target="_self">` or `rel="opener"`, bypass the renderer entirely and can survive sanitization with attacker-chosen navigation behavior. In a privileged Electron window, that leaves renderer navigation and tabnabbing risk.

# Rule

Before assigning rendered markdown to `innerHTML`, sanitize to a DOM fragment and then normalize every surviving anchor. DOMPurify controls which markup survives; a post-sanitize pass controls the navigation behavior of the surviving markup.

- `data-open-file` anchors are local viewer actions: force `href="#"` and strip `target`/`rel`.
- Other anchors must pass the URL allowlist limited to `http`, `https`, and `mailto`; replace disallowed anchors with their child nodes as plain text.
- External-link survivors get forced `target="_blank" rel="noreferrer noopener"`.

# Test shape

Cover the behavior with a DOM-backed test, such as jsdom, that inspects the normalized output. Unit-testing only the URL allowlist misses raw-HTML anchors that bypass `marked`'s renderer.

# Related concepts

- [desktop backend architecture](/architecture/desktop-backend-architecture.md)
