---
type: Lesson
title: Script-free npm materialization still installs peer dependencies
description: A checked runtime dependency can cause npm ci to auto-install a much larger peer closure whose advisories must be reviewed separately.
tags:
  - packages
  - npm
  - dependencies
  - security
timestamp: 2026-07-26
---

# Script-free npm materialization still installs peer dependencies

While extracting `oas-aweb`, the inherited dependency range `@awebai/pi@^0.2.1` locked `@awebai/pi@0.2.3`. Running the required `npm ci --ignore-scripts` did prevent lifecycle scripts, but npm also auto-installed the package's `@earendil-works/pi-coding-agent` peer. The resulting closure contained 135 packages rather than only the skill package and its direct aweb dependency.

`npm audit --omit=dev` then reported high-severity GHSA-mh99-v99m-4gvg in the peer closure's transitive `brace-expansion`. The affected peer is not needed merely to read the three packaged skills, but it is still part of the exact materialized dependency tree under the mandated command.

For independently released OAS packages, treat these as separate checks:

1. use `npm ci --ignore-scripts` to enforce the no-lifecycle-script boundary;
2. inspect `npm ls` to see automatically installed peer and optional dependencies;
3. audit the complete production closure;
4. record or escalate findings instead of applying an unreviewed override; and
5. remove generated `node_modules` after proving clean materialization, leaving only the checked lock.
