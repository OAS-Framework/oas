---
type: Lesson
title: Acquisition provenance must outrank installation location for trust
description: A package copied into a workspace-local capability directory remains externally acquired and must not inherit the trust of workspace-authored local code.
tags: [capabilities, security, trust, provenance]
timestamp: 2026-07-11
---

A package installed with a local destination such as `.agents/capabilities/`
looks identical by directory location to a package authored directly by the
workspace. Trust cannot therefore be derived from discovery origin alone.

The lockfile is the durable acquisition-provenance signal. If a discovered
local package has a lock entry, OAS must verify its integrity and require
executable approval exactly like a package installed in the laptop cache.
Only an unlocked package genuinely owned as workspace configuration may use
the config-owned trust path. This distinction prevents `--here` from silently
turning downloaded executable code into trusted local code.

For the surrounding package model, see [capability packages](/decisions/capability-packages.md).
