---
type: Decision
title: One tasks layer owns tasks — whichever integration the user binds
description: One source of truth per concern — the bound tasks integration owns tasks/rosters/outcomes; task features of OTHER tools stay off. Jira is one option, aweb tasks another, any tracker works.
tags: [tasks, layers, jira, aweb]
timestamp: 2026-07-10
---

The tasks layer is pluggable like every layer: Jira (bundled as oas-jira) is
**one** integration, not the answer. A workspace may equally bind aweb's own
task features as its tasks layer, or Linear, GitHub Issues, a team wiki —
anything an integration wraps. The user chooses.

The decision is the **exclusivity rule**, not the tool: whichever integration
is bound to `tasks` becomes the single task/roster layer, and task-like
features of every *other* tool in the workspace stay off. Many tools ship
overlapping features (messaging tools like aweb also ship task/work/lock/
roles); if aweb is bound to *messaging* while Jira holds *tasks*, aweb's task
features stay off — but in a workspace that binds `tasks: aweb`, they ARE the
task layer, legitimately.

Rationale: one source of truth per concern. The task layer is where everyone
— humans and agents — gets situated; two task systems fork truth. Mail
nudges; the tracker records.

Enforcement pattern (from the first deployment, tracker-agnostic): a
workspace comms skill stating the boundary, disabling the non-task tools'
coordination skills, and the workspace injection in every soul. Epic rosters
live in the epic description (current state) + roster comments (event log) —
same state/log split as [memory design](/architecture/memory-design.md). The
bundled oas-jira integration packages this pattern for Jira.
