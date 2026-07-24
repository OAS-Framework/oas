---
type: Lesson
title: Final PR handback requires reviewer-driven merges to be settled
description: A green handed-back SHA is stale if an in-flight reviewer can still add a fix or regression; maintainers must bind approval to the actual stable PR head and its own check run.
tags: [pull-requests, review, ci, mergeability]
timestamp: 2026-07-24
---

# Final PR handback requires reviewer-driven merges to be settled

A coordinator can hand back a green exact SHA while a post-commit reviewer is still in flight. If that reviewer produces even a test-only nit fix, the branch advances and the previously green run no longer proves the actual PR head. Treat a handback as final only after all reviewer-driven merges are settled. Immediately before verdict and merge, independently compare the PR API head, remote branch/ref, required check run's `headSha`, and merge command's expected-head guard.

# Related

- [Delivery log](/stewardship/delivery-log.md)
- [Returned PRs can go stale under fast same-capability cadence](/lessons/pr-return-staleness-fast-capability-cadence.md)
