---
type: Lesson
title: Keep cluster identity keys separate from rendered labels
description: "When a derived cluster name stabilizes grouping and ordering, removing cluster names from the UI should hide the label while preserving the internal deterministic key."
tags:
  - desktop
  - active-overview
  - clusters
  - naming
  - design
timestamp: 2026-07-25T15:00:00Z
---

# Lesson

A cluster name derived from the root-most member can act as both the stable internal grouping/ordering/dataset key and the rendered label. If a no-cluster-names request arrives, split those roles: keep `cluster.name` or the equivalent derived value for deterministic refresh stability, and remove it from rendered headers, aria labels, and other user-visible surfaces.

# Design implication

Treat derive-and-display couplings as two decisions. Display removal should not delete the derivation when the derived value carries determinism guarantees. In the Active overview cluster work, counts-only headers and aria descriptions handled the no-name display request, while category labels such as "Independent" remained because they classify a bucket rather than name a cluster. This extends [Evolve the existing Active overview hierarchy view](/lessons/active-overview-hierarchy-reuse.md).
