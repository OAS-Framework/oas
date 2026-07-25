---
type: Lesson
title: Merged-state review fixes can overreach scope — validate new user-facing surfaces with the human
description: A merged-state reviewer finding ("feature unreachable in production") was fixed by adding a brand-new nav destination + sidebar stage, which the human later rejected as out of scope; reachability fixes that create new UI surfaces need human sign-off before merging.
tags: [coordination, review, scope, desktop]
---

# Merged-state review fixes can overreach scope — validate new user-facing surfaces with the human

In the desktop-ux-fixes feature, the merged-state reviewer correctly flagged
that the new grouped roster was unreachable in the production shell. The
developer fixed it by promoting the Instances view to a first-class NAV
destination with its own stage/sidebar and palette entry. Reviews approved it
— but the human rejected the new tab/sidebar after release: the grouping
belonged in the EXISTING sidebar roster.

Lesson: when a review finding is fixed by introducing a new user-visible
surface (tab, sidebar, menu, stage) rather than modifying an existing one,
that is a product-direction decision — escalate to the human/maintainer
before merging, per the coordinator boundary "escalate product-direction
questions BEFORE building". Reachability can usually be satisfied inside
existing surfaces.

Cost: a corrective single-dev PR and a follow-up patch release after v0.18.4.
