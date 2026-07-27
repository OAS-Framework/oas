---
type: Lesson
title: Evolve the existing Active overview hierarchy view
description: "The desktop Active overview is already implemented by hierarchy.mjs, so cluster-first work should evolve that surface instead of adding a parallel tab."
tags:
  - desktop
  - active-overview
  - hierarchy
  - reuse
timestamp: 2026-07-25T12:30:00Z
---

# Lesson

When asked to build a new Active overview tab, first confirm whether the existing navigation surface already owns the destination. In the OAS desktop, `packages/desktop/renderer/views/hierarchy.mjs` is the nav item labeled "Active overview" and already implements the hard mechanics: deterministic tidy-tree forest from `parentInstance`, cycle-safe root promotion, pan/zoom/fit, per-node drag with live edges, lineage highlight, popover actions, keyboard tree-walk, and a 4s `/api/panel` poll gated by `workspaceGeneration()`.

# Design implication

Consistent with [Agent-centered desktop information architecture](/decisions/agent-centered-desktop-information-architecture.md), evolve the existing Active overview surface into the cluster-first design instead of shipping a second overview tab. Grep the nav (`shell.mjs` `NAV` array) before treating a requested "new tab" as a literally new destination.
