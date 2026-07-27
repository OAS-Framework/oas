---
type: Decision
title: npm dependency locks may live per capability inside a package
description: Materialization roots are the package root plus declared capability dirs that have both package.json and package-lock.json; each root runs an independent npm ci --ignore-scripts, and inner resources resolve manifest-relative inside containment.
tags: [packages, npm, containment]
timestamp: 2026-07-26
---

# Decision

Npm dependency locks may live per capability inside a package. Materialization
roots are the package root plus every manifest-declared capability directory
that contains both `package.json` and `package-lock.json`.

Each qualifying root is an independent `npm ci --ignore-scripts` unit. This lets
inner capability resources such as `node_modules/@awebai/pi/skills/...` resolve
relative to the inner `oas.json` while staying inside that capability's
containment boundary.

# Boundaries

Undeclared directories are never scanned for dependency closures. Every
`node_modules` directory at any depth is excluded from `packageIntegrity`; the
[depsIntegrity trust-binding lesson](/lessons/deps-integrity-trust-binding.md)
records the separate digest required for that executable materialization.

A directory qualifies as a materialization root only when it has both
`package.json` and `package-lock.json`; a package manifest without a lock file is
not enough.
