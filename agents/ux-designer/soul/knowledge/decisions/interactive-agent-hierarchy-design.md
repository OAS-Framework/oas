---
type: Decision
title: Interactive agent hierarchy design
description: "Render spawn parentage as a deterministic, cycle-safe forest whose nodes remain movable while lineage edges update live."
tags:
  - hierarchy
  - visualization
  - interaction
timestamp: 2026-07-24T10:35:50Z
---

# Decision

The Active overview is a fitted forest of agent instances derived from `parentInstance`, including cross-root parentage. Initial placement is deterministic, but users may drag nodes; edges follow live. The canvas supports pan, zoom, fit, selection, keyboard traversal, and lineage highlighting.

# Rationale

A deterministic first layout makes the same roster recognizable across refreshes, while drag/pan/zoom handles real teams that do not fit a rigid tree. Highlighting ancestors and descendants reveals coordination context without permanently emphasizing every edge.

# Failure behavior

Malformed parentage must never break the overview. Missing parents become roots, cycles use a safe deterministic fallback, and relationships crossing workspace/repository grouping boundaries stay connected when their identifiers are valid.
