---
type: Concept
title: Config cascade with closest-wins semantics
description: resolveOasConfig walks the full directory chain of oas-config.yaml files upward and resolves every setting with closest-declaration-wins semantics, which is the single rule to internalize before touching resolution code.
tags: [config, cascade, resolveOasConfig, configChain]
timestamp: 2026-07-21
---

# How resolution works

`configChain(startDir)` collects every `oas-config.yaml` from `startDir` up
to filesystem root (typical chain: repo → workspace → laptop `~`). Each entry
carries `_level` (its directory). `resolveOasConfig(contextDir, soulName)`
then resolves against that chain with one consistent rule: **the closest
declaration wins**.

Concretely:

- **team**: `chain.find((c) => c.team)` — first (closest) `team:` block wins
  and its `_level` becomes `team.scope`, the deployment boundary.
- **kernel injection**: closest scope that declares `oas: injection-override:`.
- **fundamental layers** (knowledge/messaging/tasks): exclusive slots filled
  by capability manifests' `layer:` declarations; `capabilities.layers.<layer>:
  none` at a closer scope suppresses an inherited outer activation; activating
  and disabling the same layer at the SAME scope is an error.
- **capability targeting**: global < agent-type < soul specificity, with
  settings merged in that order (test: "target composition applies global +
  agent-type + soul specificity and exclusions").
- **manifest discovery**: `capabilityManifests` scans each level's
  `.agents/capabilities/{installed,owned}` — inner-scope copies shadow outer
  ones for the same capability id.

# Gotchas

- `injection-override:` is **forbidden on `from: owned` and `from: path:`**
  entries — you own the package source, edit its `injects/` file directly; an
  override there is a drift trap (two places editing the same text).
- Renamed/removed keys (`injection:`, `groups:`, `from: bundled`,
  work-mode `injection-override`) are rejected at `loadLevelConfig` with
  pointed migration errors — extend that table when renaming keys.
- `resolveWorkMode` skips work-mode entries that declare nothing useful —
  otherwise an inner scaffold's empty entry masks an outer scope's `setup:`.
