---
type: Lesson
title: Init-time acquisition cannot rely on config-chain discovery
description: capabilityManifests only scans scopes that already have an oas-config.yaml, so oas init must use acquisition results directly before writing config.
tags: [capabilities, init, discovery, gotcha]
timestamp: 2026-07-17
---

While making `oas init` acquire marketplace layer capabilities, the package was
copied into `<dir>/.agents/capabilities/installed/` by `acquireCapability()`,
but a follow-up `capabilityManifest(id, dir)` returned undefined. Discovery
walks the config chain, and the scope's `oas-config.yaml` does not exist yet
at that point in init.

The fix was to trust the acquisition result (`{ ...r.manifest, _origin:
"installed:<dir>" }`) for the scaffold decision instead of re-discovering the
manifest. General rule: any command that acquires before writing config must
not round-trip through chain-based discovery in between.

A related migration-order gotcha: when a validation error blocks a config key
such as `from: bundled`, the migration message must be orderable. Because
`oas install` itself resolves the config chain, guidance must say to edit the
config first and then install; otherwise the error blocks its own remedy.

Related decision: [Marketplace over bundled, work modes simplified, runtime
integration at spawn](/decisions/marketplace-workmodes-runtime.md).
