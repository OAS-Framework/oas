---
type: Concept
title: Capability-defined agents resolve on declaration, with _soulDir/_dir split
description: A capability manifest's agents array ships read-only souls inside the package that resolve wherever the capability is DECLARED in the config chain (not via per-soul binding), with instances homing under local-agents/ via the _dir/_soulDir split.
tags: [capabilities, agents, findCapabilityAgent, findInstanceHome, _soulDir, spawn]
timestamp: 2026-07-24
---

# The mechanism

A capability manifest may declare `agents: ["agents/reviewer"]` — package-
relative soul directories (soul.yaml + AGENTS.md). Two design points to hold
onto:

1. **Resolution on DECLARATION, not per-soul binding.** `findCapabilityAgent`
   collects capability ids from `declaredCapabilityIds(contextDir)` — every
   capability entry anywhere in the config chain — and searches those
   manifests' `agents:` lists. The capability being *declared* in the context
   makes its agents spawnable; there is no soul-targeting step for agent
   availability (targeting governs capability *bindings*, not the existence
   of package agents).

2. **The `_dir` / `_soulDir` split.** A capability agent record carries:
   - `_soulDir`: the canonical soul, **read-only inside the package** —
     `spawnInstance` uses `agent._soulDir || soulOf(agent._dir)` for the soul
     symlink and composition;
   - `_dir`: `<root>/local-agents/<name>` — where **instances home**, without
     a local soul directory (status/retire find such homes by scanning
     `local-agents/<name>/instances/`).

# Implications

- Never write into `_soulDir` (it lives in the installed/owned package tree
  and is integrity-covered for installed packages).
- Soul paths from a manifest go through `manifestPath` — subject to the
  containment check (and the marketplace hoisted-path exemption).
- When adding features that enumerate agents (status, doctor), remember both
  populations: root souls via `listAgents(root)` and package agents via
  `listCapabilityAgents(contextDir)`.
- When adding any by-name **instance** lookup, use exported
  `findInstanceHome(root, name)` instead of iterating `listAgents(root)`.
  Capability-defined agents home under `local-agents/<name>/instances/`
  without a local `soul.yaml`, so `listAgents` alone cannot see their live
  instances.
