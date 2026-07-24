---
type: Lesson
title: Server reuse needs an identity probe, not just a liveness probe
description: Desktop server reuse must compare an identity/version response with the local checkout's manifest, because a server that answers workspace endpoints can still be an incompatible older or newer install.
tags: [desktop, server, compatibility, versioning, testing]
timestamp: 2026-07-24
---

A server that answers `/api/panel` for the workspace is live, but not
necessarily compatible with the desktop checkout. An older global `oas-web`
install can pass the workspace probe and still 404 newer endpoints such as
`/api/brain`, `/api/file`, or `/api/diff`, making feature views look broken.

Reuse decisions should probe a minimal server identity endpoint, `GET
/api/version`, returning `{ capability, version }` from `oas.json`, then compare
that response against the local checkout's manifest. Reuse only when capability
and version match exactly; a 404, mismatch, or network failure should fail
closed by spawning this checkout's server on a free port. Do not kill the
foreign server; this matches the workspace-mismatch posture.

Exact match is preferable to a `>= minVersion` rule here: it avoids
version-ordering code and also rejects a newer foreign server whose API may have
moved. The endpoint values should come from the manifest, not a hardcoded
string, so the package version remains the single source of truth.

Regression fixtures that mean "wrong identity" must use impossible sentinels,
not plausible real versions. During the package migration, a compat test used
`version: "0.1.0"` as the mismatch fixture; after `/api/version` moved from
`oas.json` to `packages/desktop/package.json`, the desktop package's real
version was also `0.1.0`, so the "mismatch" matched and the assertion flipped.
Use values like `"0.0.0-other"` for identity-mismatch fixtures.

Keep the review bar from [Regression tests must exercise the layer that had the bug](/lessons/regression-tests-bug-layer.md):
extract the reuse decision into its own module, cover the real stale global
server trigger with a fake-server end-to-end test, and mutation-check that
disabling the missing-version guard fails the tests.
