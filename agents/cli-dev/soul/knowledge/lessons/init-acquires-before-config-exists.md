---
type: Lesson
title: Init acquires before the config exists — bypass chain discovery mid-init
description: During oas init the scope's oas-config.yaml does not exist yet, so capabilityManifests cannot discover a just-acquired capability through the config chain; init must use the acquisition result (destination dir/manifest) directly.
tags: [cli, init, acquireCapability, capabilityManifests, gotcha]
timestamp: 2026-07-21
---

# The gotcha

`oas init --knowledge oas.okf` acquires the capability into
`.agents/capabilities/installed/` **before writing** `oas-config.yaml`. But
`capabilityManifests(startDir)` only surfaces installed stores at levels
where a config file exists in the chain — so a manifest lookup right after
acquisition returns `undefined`, even though the copy is on disk. This bit
during the v0.13.0 marketplace migration: acquisition succeeded, the follow-up
`capabilityManifest(id)` came back empty.

# The rule

Mid-init (or in any flow that acquires before the scope's config exists), do
not re-discover through the chain. Use what `acquireCapability` returns — the
destination directory / loaded manifest — directly. Similarly, marketplace-id
validation at init time needs `marketplaceCapabilities()` (a direct scan of
`MARKETPLACE_DIR`), because ambient discovery will not know marketplace ids.

# Corollary for tests

A lock file without a config is not a discoverable scope: tests exercising
"present" checks must write a minimal `oas-config.yaml` at the level, matching
real deployments where discovery is scoped to config-bearing directories.
