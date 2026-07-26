---
type: Lesson
title: PR reviews need semantic knowledge consistency checks after branch-union harvests
description: Strict OKF validation proves structure, not truth; branch-union harvests need a human semantic read so transitional concepts match the final converged design or mark history as superseded.
tags: [pull-requests, review, okf, knowledge, merge]
timestamp: 2026-07-25
---

# PR reviews need semantic knowledge consistency checks after branch-union harvests

Strict OKF validation can pass while newly harvested soul knowledge is semantically stale. PR #35's Desktop keybindings code and tests were green, and strict OKF passed, but a transitional decision concept still listed an export that no longer existed and described caller-side dispatch guards after the final engine had internalized them.

When a PR includes harvested soul knowledge from multiple feature branches or branch-union conflict resolutions, maintainer review needs a targeted semantic read of the new and changed concepts, especially concepts that describe transitional contracts. The check is: does the concept describe the final converged design, or clearly mark a historical behavior as superseded and link to the superseding concept?

# Related

- [Delivery log](/stewardship/delivery-log.md)
- [Final PR handback requires reviewer-driven merges to be settled](/lessons/final-handback-requires-settled-reviewer-merges.md)
