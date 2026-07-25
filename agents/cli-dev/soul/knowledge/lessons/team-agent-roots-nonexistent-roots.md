---
type: Lesson
title: teamAgentRoots nonexistent roots are anchors, not optional directories
description: teamAgentRoots may return nonexistent <scope>/agents paths so callers can derive localAgentBases(root); deployment-wide scans must keep missing roots as resolve(root), not skip them after failed realpath.
tags: [team, teamAgentRoots, local-agents, scanning, retire]
timestamp: 2026-07-25
---

# Lesson

`teamAgentRoots()` can deliberately return a `<scope>/agents` path that does not
exist. In all-local sibling scopes, that nonexistent root is still the anchor
callers need to derive `localAgentBases(root)` and find instances under
`local-agents/`.

Do not normalize agents roots with `try { realpathSync(root) } catch { continue }`.
A missing agents dir must be retained as `resolve(root)`. Dropping it made
all-local sibling instances invisible to attached owner discovery and
retire-splice scans, reopening the shadow-parent lineage hole.

Grep rule: any `realpathSync(<agents root>)` wrapped in catch-and-skip is
suspect. When deduping or normalizing deployment-wide roots, use realpath for
existing roots and a `resolve()` fallback for missing roots.

# Test fixture note

To create same-named instances across repos in tests, the shadow repo needs a
same-named agent/soul; instance names are prefixed with the agent name, so same
instance names require same agent names. For local souls, put the same-named
agent under `local-agents/`.

# Related

This narrows the team-scope scan rule in
[team scope and cross-repo spawn](/lessons/team-scope-and-cross-repo-spawn.md)
and the team-wide retire-splice requirement in
[spawn relations lineage fields](/architecture/spawn-relations-lineage-fields.md).
