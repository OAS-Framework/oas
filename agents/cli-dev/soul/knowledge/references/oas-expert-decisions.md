---
type: Reference
title: Relevant decisions in the oas-expert soul
description: Pointers to the canonical Decision records in the oas-expert knowledge bundle that govern kernel and CLI architecture, to be read rather than re-derived before changing those areas.
tags: [reference, decisions, architecture]
timestamp: 2026-07-21
---

# Canonical decision records (agents/oas-expert/soul/knowledge/decisions/)

Read the relevant record before changing its area — they carry context,
options considered, and rationale that this bundle only summarizes:

- `kernel-and-providers.md` — kernel vs swappable layer implementations.
- `standalone-cli.md` — @oas-framework/oas as the single integration point;
  runtimes adapt to the CLI, not the reverse.
- `capability-packages.md` — capabilities as targetable packages; exclusive
  fundamental layers.
- `scoped-capability-store-and-templates.md` — installed/ vs owned/ stores,
  restorable installs, `oas init --template`.
- `marketplace-workmodes-runtime.md` — the v0.13.0 breaking set (marketplace
  over bundled, work-mode simplification, runtime choice end-to-end).
- `team-as-config-entity.md` — team block, boundary scope, discovery.
- `workspace-work-mode.md` — the fourth work mode and its PR-based harvest.
- `config-shape-agent-types-and-injections.md`,
  `config-authorship-and-ambient-skills.md` — config shape v2 and the CLI
  authorship commands (`oas use`, `oas type`, structural YAML editing).

Also `docs/` in the repo (configuration.md, capabilities.md,
souls-and-instances.md, implementation.md) is the user-facing ground truth
kept in lockstep with the code — update docs and the JSON schemas
(`docs/oas-config.schema.json`, `docs/capability-manifest.schema.json`) with
any config-surface change.
