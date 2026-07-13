---
type: Lesson
title: Unquoted colons in skill descriptions silently kill skills
description: A YAML description containing ": " fails to parse and the skill silently doesn't load — use >- block scalars and verify loading.
tags: [skills, yaml, gotcha]
timestamp: 2026-07-08
---

Our first packaged skill (agent-memory) silently failed to load: the
frontmatter `description` contained `: ` (colon-space) unquoted, which is a
YAML nested-mapping error. pi reported it only as a loader diagnostic
(`loadSkills(...).diagnostics`), not as a visible error.

Rules: use `>-` block scalars for descriptions; after creating any skill,
verify it actually loads (ask a session to list it, or run loadSkills and
check diagnostics). Now encoded in the skill-craft packaged skill.
