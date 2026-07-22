---
type: Lesson
title: Sanitize marked markdown before innerHTML
description: Rendered markdown from untrusted files must pass through DOMPurify plus an http/https/mailto URL-scheme allowlist before assignment to innerHTML because marked preserves raw HTML.
tags: [oas-web, desktop-viewers, markdown, security, xss]
timestamp: 2026-07-22
---

# The trap

Markdown files opened in desktop viewers are untrusted input. Running them through `marked` is not a sanitizer: `marked` preserves raw HTML, and assigning that output to `innerHTML` can execute hostile markup.

# Rule

Before assigning rendered markdown to `innerHTML`, pass it through DOMPurify and keep an explicit URL-scheme allowlist limited to `http`, `https`, and `mailto`.

# Related concepts

- [oas-web architecture](/architecture/oas-web-architecture.md)
