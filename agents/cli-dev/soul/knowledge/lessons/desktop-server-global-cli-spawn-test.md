---
type: Lesson
title: desktop-server spawn unavailable test depends on global CLI absence
description: test/desktop-server.test.mjs can fail locally with 409 instead of the expected cli-unavailable 503 when a compatible global oas CLI is installed, because the desktop server resolves the real CLI and never enters the unavailable-adapter path.
tags: [tests, desktop, environment, ci]
timestamp: 2026-07-25
---

# Lesson

On a developer machine with a compatible global `@oas-framework/oas` CLI installed, `npm test` can fail the `test/desktop-server.test.mjs` assertion that POST `/api/spawn` without a bundled CLI adapter degrades with 503 (`cli-unavailable`). The desktop server's CLI discovery finds the global `oas` binary, spawn validation proceeds, and the request fails with 409 instead.

This was verified as pre-existing by stashing changes and rerunning against the clean tree. CI runners without a global `oas` CLI stayed green. When judging local `npm test` results on desktop-server suites, check for global CLI resolution before blaming the diff.
