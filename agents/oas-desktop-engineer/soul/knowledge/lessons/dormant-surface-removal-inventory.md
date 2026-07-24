---
type: Lesson
title: Dormant surface removals need absence inventory tests
description: Removing shipped-dormant desktop surfaces can leave tendrils across routes, renderers, harnesses, styles, docs, and multiple test trees, so the removal needs a bundle inventory test that proves the deleted surfaces stay absent while a kept surface remains present.
tags: [desktop, release, testing, removal]
timestamp: 2026-07-24
---

When removing shipped-dormant Desktop surfaces, treat the deletion as a cross-bundle inventory problem rather than a view-only cleanup. The Diff/Jira removal for v0.18.0 left tendrils in server route regex families, the `api-url` WebSocket-pinning route family, `panelData` fields, instance state/generation counters, renderer harness tabs and prompts, theme styles, READMEs, and tests under `packages/desktop/test`, root `test/`, and root `tests/`.

Before calling the removal done, grep the feature names case-insensitively across `.mjs`, `.cjs`, `.html`, `.css`, and `.md` files and across all test roots. Route-family remnants are easy to miss because a deleted view can still be reintroduced by a shared classifier or helper.

Pin the absence with an inventory test near the desktop bundle, such as `packages/desktop/test/inventory.test.mjs`. The test should assert that the removed modules do not exist, helpers and routes are absent from server source, route families exclude the deleted kinds, and renderer files no longer import or style them. Include at least one positive assertion for a kept surface, such as `/api/file`, so the test cannot pass merely because it scanned an empty or wrong tree.

Absence greps over shipped sources also match explanatory comments. When a removal test for strings such as `lib/core.mjs` or `FRAMEWORK_ROOT` fails only because a comment names the removed bridge, reword the comment (for example, "kernel module" or "framework-root override") rather than weakening the test or excluding comments.
