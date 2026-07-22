---
type: Lesson
title: Retire developers without holding on docs-only follow-up PRs
description: A docs-only follow-up PR does not need its authoring developer alive — the coordinator can shepherd it and retire the instance once code is merged and notes are harvested.
tags: [retirement, coordination, follow-up-pr]
timestamp: 2026-07-22
---

# Lesson

During the oas.web terminal-fidelity delivery (PR #8), review left two
non-blocking doc nits fixed in a docs-only follow-up (PR #10). Holding the
developer instance alive just to await a docs-only merge wastes an instance:
once the feature is merged, the dev's memory protocol is complete (notes
harvested, branches deleted), the coordinator can take over shepherding the
follow-up PR with the maintainer and retire the developer immediately.

Precondition checklist before retiring: feature PR merged, harvest confirmed
("no pending notes"), local+remote branches deleted, dev reports task complete.
