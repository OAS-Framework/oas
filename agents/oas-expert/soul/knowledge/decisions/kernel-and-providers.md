---
type: Decision
title: Kernel and providers
description: OAS separates the native soul/instance kernel from swappable knowledge, messaging, and tasks implementations; capability packages later generalized the provider distribution unit.
tags: [architecture, packaging, integrations, config, core]
timestamp: 2026-07-11
---

**Status: decided 2026-07-09; package mechanics refined and partly superseded
2026-07-11 by [capability packages](/decisions/capability-packages.md).** The
kernel/layer boundary remains authoritative. The old acquisition, ambient skill
scoping, and soul-mutating injection details do not.

# Context

OKF memory and aweb support originally lived directly in core. OAS needed to
name the stable specialization pattern while allowing concrete knowledge,
messaging, and tasks tools to vary by deployment.

# Decision that remains

- The **kernel** owns soul/instance ontology and layout, names, spawn/resume/
  retire, work topology, config resolution, generated runtime composition,
  and generic lifecycle hook points.
- The kernel is memory-agnostic. A knowledge implementation owns its soul and
  instance files, capture/promotion discipline, and format skills.
- Knowledge, messaging, and tasks are formal, swappable, exclusive fundamental
  layers. Core owns instance names; messaging owns addressability; the
  selected task integration owns task state.
- Concrete implementations are packages, not hard-coded kernel features.
  `oas-okf` and `oas-aweb` are shipped defaults; Jira and Linear are available
  task choices.
- Work modes (`worktree`, `checkout`, `attached`) remain kernel topology, not
  provider packages.

# 2026-07-11 refinement

The old term “provider package” is now the constrained case
**integration**—a capability package selected for one fundamental layer.
General capability packages are additive. Acquisition is locked and separate
from config-owned activation; global/group/soul bindings replace ambient
workspace skill attachment. Spawn creates exact instance-local skills and
instructions instead of mutating committed souls. Executable external
surfaces require integrity-bound trust.

# Rejected boundaries

- Monolithic feature flags: concrete tools would remain hard-coded and custom
  deployments second-class.
- Making soul/instance layout a provider: those layers are the OAS pattern
  itself.
- Removing formal layer slots in favor of unrestricted additive packages:
  competing knowledge/task/messaging implementations would lose explicit
  ownership and exclusivity.
