---
type: Reference
title: Agent Skills standard
description: The SKILL.md format and creator guides (agentskills.io) that OAS packaged skills follow and skill-craft distills.
resource: https://agentskills.io/specification
tags: [skills, standard]
timestamp: 2026-07-08
---

The Agent Skills standard (agentskills.io, Anthropic-originated; pi
implements it). Skill = directory with SKILL.md (frontmatter: `name` matching
dir, `description` ≤1024 chars carrying ALL triggering burden) + optional
scripts/, references/, assets/. Body ≤500 lines; progressive disclosure via
"read X when Y" references.

Creator guides distilled into our `skill-craft` packaged skill:
best-practices (ground in real expertise, gotchas sections, defaults not
menus, plan-validate-execute), optimizing-descriptions (trigger evals with
should-fire + near-miss prompts), evaluating-skills (with/without comparison),
using-scripts (bundle reinvented logic, self-correctable errors).

Companion: the agents.md standard ([concept](/references/agents-md-standard.md)).

# Citations

[1] [Specification](https://agentskills.io/specification)
[2] [Best practices](https://agentskills.io/skill-creation/best-practices.md)
[3] [Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions.md)
[4] [Evaluating skills](https://agentskills.io/skill-creation/evaluating-skills.md)
