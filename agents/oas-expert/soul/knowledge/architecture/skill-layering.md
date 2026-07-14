---
type: Area Guide
title: Skill layering
description: The content-layer rule for always-loaded instructions, on-demand skills, and index-first knowledge, plus exact capability-selected instance distribution.
tags: [skills, memory, capabilities]
timestamp: 2026-07-14
---

# Content layers

| Layer | Loaded | Belongs there |
|---|---|---|
| canonical soul `AGENTS.md` | always | durable role, boundaries, default loop, memory pointers |
| generated capability blocks | always in selected instances | scope-specific awareness and mandatory package protocol |
| skills | on demand by description | repeatable procedures (how) |
| knowledge | on demand, index-first | facts, decisions, lessons (what/why) |

Test a canonical AGENTS line: would removing it cause mistakes in most
sessions of this soul across deployments? If not, place it in an activated
capability block, skill, or knowledge concept.

# Distribution

A skill's source may be kernel, soul-private, or an active capability package.
Spawn resolves the target soul and materializes exactly those sources into the
instance's `.agents/skills`; the runtime adapter package is not a second skill
resolution layer. Duplicate names error unless config explicitly selects an
override. `instance.json` records every name and source.

Pi disables ambient skill discovery and receives the one instance directory
explicitly. Claude receives canonical project and config-home symlinks to the
same directory. Workspace/config/package ancestor roots are not OAS runtime
visibility surfaces. `oas-getting-started` is the sole ambient pre-workspace
bootstrap.

# Curriculum routing

- `oas` is kernel-owned and present in every instance.
- `okf` and `memory-harvest` come from the selected `oas.okf` knowledge
  integration.
- `integration-authoring`, `skill-craft`, and `soul-craft` are distributed by
  the additive `oas.authoring` capability to explicit authoring souls.
- Role-specific skills remain under the soul unless sharing/distribution makes
  them a capability package.

Declarative lessons become knowledge concepts; repeatable procedures become
skills; both remain cross-linked and maintained together.
