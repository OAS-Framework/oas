---
type: Lesson
title: Surface removal inventories must include user-facing recovery copy
description: When removing a UI surface, inventory user-facing fallback and recovery text as well as imports, navigation, modules, and styles.
tags: [desktop, ux, review, regression]
timestamp: 2026-07-25
---

# Surface removal inventories must include user-facing recovery copy

PR #32 removed the out-of-scope Desktop Instances stage, but its first review round missed a delayed-spawn fallback that still directed users to the deleted “Instances view”. A broad assertion that the operation failed truthfully stayed green while the recovery copy named a destination the same PR removed.

When removing a UI surface, inventory more than imports, navigation entries, modules, and CSS. Search user-visible fallback and recovery copy, error paths, comments that describe user flow, and regression tests for references to the old surface; pin the replacement destination explicitly instead of accepting generic failure assertions.

# Related

- [Delivery log](/stewardship/delivery-log.md)
