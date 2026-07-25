---
type: Lesson
title: Build option lists from data with createElement, never innerHTML attributes
description: escapeHtml is text-context escaping only, so workspace paths or other data must enter option-list DOM through createElement, textContent, and dataset rather than template-string innerHTML attributes.
tags: [desktop, security, dom, injection, renderer]
timestamp: 2026-07-25
---

# Build data-derived DOM without innerHTML attributes

Review finding `cbd5bb3`: the spawn modal's reference picker built options with
`innerHTML` template strings. It passed `agentsRoot` through `escapeHtml` into a
`data-root="..."` attribute and interpolated a derived tag with no escaping at
all. The local `escapeHtml` helper escaped only `&`, `<`, and `>`; it did not
escape quotes. A valid workspace path containing `"` could therefore break out
of the attribute, and other HTML-significant path characters could inject
markup.

# Rule

Data-derived DOM is constructed, not interpolated:

- create elements with `document.createElement`;
- set labels with `textContent`;
- put identity/path data into `dataset` or other DOM properties;
- never use `innerHTML` template strings for paths, names, roster fields, or
  derived labels, even when the value has passed through `escapeHtml`.

`escapeHtml` is a text-context helper only. It must not be treated as attribute
escaping unless it actually escapes quotes for that attribute context.

# Regression shape

Exercise the real builder with a hostile path such as
`/tmp/x"><img src=x onerror=...>/agents`. Assert that no extra element is
created and that the DOM-preserved `dataset` value matches the input
byte-for-byte.

For root labels derived from paths, test collisions too. Single-segment tags can
collide, for example `/a/project/agents` and `/b/project/agents` both becoming
`[project]`; grow suffixes until labels are unique, as with
`distinguishingRootTags` in `renderer/instance-tree.mjs`, and assert duplicate
roots render with different labels.

# Related concepts

- [Never interpolate data-derived identity into querySelector](/lessons/no-dynamic-selectors-from-data.md)
- [Sanitize and normalize markdown anchors before innerHTML](/lessons/sanitize-marked-markdown-before-innerhtml.md)
- [Security regressions must exercise behavior, not source strings](/lessons/behavioral-security-regressions.md)
