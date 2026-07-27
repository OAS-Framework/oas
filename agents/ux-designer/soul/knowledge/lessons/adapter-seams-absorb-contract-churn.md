---
type: Lesson
title: Absorb pending contract churn with adapter seams
description: "When an upstream contract's final name or shape is pending, route reads through one adapter seam and consume shared helpers as black boxes so landed changes stay small and test-pinned."
tags:
  - design
  - adapter
  - contracts
  - active-overview
timestamp: 2026-07-25T20:00:00Z
---

# Lesson

When an upstream contract's final name or shape is still pending, build the adapter seam first. In the Active overview work, sibling relation reads went through one `siblingLinksOf()` adapter while identity resolution consumed the shared `resolveLinkId` helper instead of reimplementing it. Four upstream changes — speculative sibling field names to final `siblingInstance`, absent strings to `string|null`, helper introduction, and helper semantic tightening to exactly-one same-root — then landed as one-line adapter edits or no feature diff beyond re-running and pinning tests.

# Practice

Name the seam in coordination mail so coordinators can reason about where churn is isolated. After each upstream shape lands, pin that shape with a regression test rather than widening the adapter's tolerance. When a peer owns a helper's semantics, verify and pin the behavior that flows through your surface; do not fork the helper just to freeze the old behavior.

This complements [Resolve team-scoped roster relations with composite full-scope identity](/lessons/team-roster-identity-resolution-scope.md): relation-field semantics should be resolved at the owned seam, then preserved through layout and rendering code.
