---
type: Lesson
title: Skill routing must respect availability context
description: The pi adapter exposes only oas-getting-started before workspace spawn, so bootstrap-critical package/config acquisition steps must remain inline there and may defer only to instance-baseline skills for post-spawn contexts.
tags: [skills, routing, bootstrap, pi-adapter]
timestamp: 2026-07-26
---

# Lesson

Do not route from an ambient pre-workspace skill to a skill that only exists
inside spawned instances. The pi adapter (`packages/pi/extension/index.ts`)
exposes only `oas-getting-started` as the ambient/pre-workspace bootstrap
skill; `oas-packages`, like the rest of the instance baseline, is available
inside spawned instances.

Routing `oas-getting-started` package acquisition/trust steps to `oas-packages`
therefore makes first-time setup unroutable during the bootstrap phase the skill
exists to cover.

# Rule

Before pointing skill A at skill B, check where each skill is available:

- ambient / pre-workspace;
- instance baseline;
- capability-supplied.

A bootstrap skill must stay self-contained for every step that can occur before
the first spawn. Deferral pointers are fine only for post-spawn operations, and
should say so explicitly, for example: "available inside spawned instances".

# Check

When editing `oas-getting-started` routing, grep the pi adapter's skill exposure
list to confirm which skills are available during bootstrap.
