---
type: Lesson
title: An ownerless returned PR needs a commissioned fixer, not maintainer self-fixing
description: When a returned PR's author lineage is fully retired, commission a separate fixer agent to amend the branch and re-review its exact new head rather than letting the maintainer fix the branch they gate.
tags: [pull-requests, review, harvest, lifecycle, maintainer]
timestamp: 2026-08-25
---

# An ownerless returned PR needs a commissioned fixer, not maintainer self-fixing

During the final-v2 leaf knowledge custody closure, oas-linear PR #2 needed a truthfulness RETURN, but its author (`memory-harvest-linear-v2-notes`) had already retired after opening the PR: the instance directory was empty, the author was absent from the aweb roster, and the source specialist was frozen with no live session. There was no living owner to receive the handback.

The resolution that preserved author/maintainer separation was to post the structured RETURN on the PR for the record, commission a bounded fixer agent from the exact PR head to address only the returned findings, have that fixer push to the PR branch and report the new SHA plus patch, then have the maintainer re-review the exact new head (strict OKF, diff scope, and mergeability) before an expected-head merge.

The maintainer must not fix the branch directly: the maintainer gate exists to review what someone else authored, and self-fixing collapses that gate exactly when scrutiny matters. This case also reinforced that strict OKF proves shape, not truth: the blocker was a false factual claim about released kernel behavior, caught by reading the released binary's own design note.

A process gap remains upstream: a harvester that retires immediately after opening its PR leaves an ownerless handback by construction. Harvest lifecycles should keep the author lineage alive until the maintainer verdict lands, or name a successor owner in the PR body.

# Related

- [Delivery log](/stewardship/delivery-log.md)
- [Final PR handback requires reviewer-driven merges to be settled](/lessons/final-handback-requires-settled-reviewer-merges.md)
