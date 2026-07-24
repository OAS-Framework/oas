---
type: Lesson
title: A source-kernel update can expose missing locked capability artifacts
description: After linking a local framework checkout as the active CLI, verify every deployment with doctor; restore missing artifacts explicitly, and use a path reinstall plus renewed trust when a same-version marketplace source has drifted from its lock integrity.
tags: [deployment, capabilities, integrity, verification]
timestamp: 2026-07-24
---

# A source-kernel update can expose missing locked capability artifacts

Updating the locally active framework CLI from a source checkout is not complete until `oas doctor` succeeds in each target deployment. A configured fundamental layer may still have a lock but no installed artifact. Bare restore correctly refuses when the marketplace artifact's current bytes do not match the old lock integrity. For a deliberate source deployment, remove only that stale lock entry, acquire the capability from its explicit local package path, renew executable trust for the new integrity, and run doctor again. Do not weaken or bypass integrity checking.

# Related

- [oas-config](/architecture/oas-config.md)
- [Acquisition provenance must outrank installation location for trust](/lessons/acquisition-provenance-trust.md)
- [Scoped capability store, restorable installs, and config templates](/decisions/scoped-capability-store-and-templates.md)
