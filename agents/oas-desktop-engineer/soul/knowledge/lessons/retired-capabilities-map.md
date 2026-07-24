---
type: Lesson
title: Retired capabilities need a kernel-level retirement map
description: Shipped-then-removed capabilities leave stale config and lock references in the wild, so every load path that can encounter them must emit the same actionable migration message from one exported kernel map.
tags: [kernel, capability, retirement, diagnostics, breaking-change]
timestamp: 2026-07-24
---

When `oas.web` was removed, three distinct stale-reference paths would have
produced opaque errors: `resolveOasConfig` ("no manifest was acquired"),
`acquireCapability` ("not a marketplace capability id"), and
`restoreCapabilities` ("unknown source" / `FAILED`).

The fix shape is one exported `RETIRED_CAPABILITIES = { id: guidance }` map in
`lib/core.mjs`. Config activation, explicit install, lock restore, and doctor
all consult the same map, and `restoreCapabilities` reports a non-fatal
`retired` status so bare `oas install` does not die on stale locks.

Regression coverage should drive each stale-reference path and assert that the
old opaque messages do not appear.

Rule: a breaking capability removal is not done until every path a stale
reference can take names the successor and the exact cleanup step.
