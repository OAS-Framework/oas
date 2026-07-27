---
type: Lesson
title: New intentional kernel skills must update the clean-room smoke exact baseline
description: scripts/clean-room-smoke.mjs asserts the exact packed-skill inventory for spawned instances, so intentional kernel skill additions must extend that baseline rather than weakening it.
tags: [testing, smoke, skills, package-engine]
timestamp: 2026-07-27
---

# New intentional kernel skills must update the clean-room smoke exact baseline

`scripts/clean-room-smoke.mjs` compares a spawned instance's `.agents/skills`
directory against an exact sorted list. As of PR #51, that list is
`["memory-harvest", "oas", "oas-config", "oas-packages", "okf", "private"]`.

Any intentional change to which kernel skills are injected at spawn — adding a
skill like `oas-packages`, renaming a skill, or changing injection defaults —
must update this list in the same commit, or `npm run smoke:tarball` can fail
on a green product. The assertion is intentionally exact so it catches
accidental skill leakage into packed spawns; extend the list, do not loosen it
to a subset check.
