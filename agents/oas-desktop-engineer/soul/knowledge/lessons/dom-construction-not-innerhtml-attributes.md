---
type: Lesson
title: Assign workspace data to DOM properties, never interpolate it into attributes
description: escapeHtml is text-context escaping only, so workspace-controlled strings must enter DOM attributes through properties, dataset, or createElement rather than template-string innerHTML attributes.
tags: [desktop, security, dom, injection, renderer]
timestamp: 2026-07-25
---

# Assign data-derived DOM properties instead of interpolating attributes

Review finding `cbd5bb3`: the spawn modal's reference picker built options with
`innerHTML` template strings. It passed `agentsRoot` through `escapeHtml` into a
`data-root="..."` attribute and interpolated a derived tag with no escaping at
all. The same bug class later appeared in the model input placeholder
(`merged-state` at `3e76616`): a workspace-controlled string reached an HTML
attribute inside a template. The local `escapeHtml` helper escaped only `&`, `<`,
and `>`; it did not escape quotes. A valid workspace path or other
workspace-controlled string containing `"` could therefore break out of the
attribute, and other HTML-significant characters could inject markup.

# Rule

Workspace-derived DOM is assigned, not interpolated:

- create elements with `document.createElement` when practical;
- set labels with `textContent`;
- put identity/path data into `dataset` or other DOM properties, such as
  `el.placeholder = value`, `el.dataset.root = value`, or `el.value = value`;
- never use `innerHTML` template strings for paths, names, roster fields,
  placeholder text, or derived labels, even when the value has passed through
  `escapeHtml`.

`escapeHtml` is a text-context helper only. It must not be treated as attribute
escaping unless it actually escapes quotes for that attribute context. When
touching a template, grep-audit `${escapeHtml(` occurrences that sit inside
`="..."` attribute positions.

# Regression shape

Exercise the real builder with a hostile path such as
`/tmp/x"><img src=x onerror=...>/agents`. Assert that no extra element is
created and that the DOM-preserved property or `dataset` value matches the input
byte-for-byte. A cheap whole-modal invariant is that no element in the rendered
container has an attribute whose name starts with `on`.

For root labels derived from paths, test collisions too. Single-segment tags can
collide, for example `/a/project/agents` and `/b/project/agents` both becoming
`[project]`; grow suffixes until labels are unique, as with
`distinguishingRootTags` in `renderer/instance-tree.mjs`, and assert duplicate
roots render with different labels.

# Related concepts

- [Never interpolate data-derived identity into querySelector](/lessons/no-dynamic-selectors-from-data.md)
- [Sanitize and normalize markdown anchors before innerHTML](/lessons/sanitize-marked-markdown-before-innerhtml.md)
- [Security regressions must exercise behavior, not source strings](/lessons/behavioral-security-regressions.md)
