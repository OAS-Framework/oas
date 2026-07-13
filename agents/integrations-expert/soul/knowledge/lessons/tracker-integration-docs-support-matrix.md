---
type: Lesson
title: Tracker integration docs need an explicit support matrix
description: Task integrations that mention projects or documents must distinguish supported commands, UI-only operations, ownership boundaries, and relationships between project context and executable issues.
tags:
  - integrations
  - tasks
  - documentation
timestamp: 2026-07-10
---

# Tracker integration docs need an explicit support matrix

A command list is insufficient documentation for a tasks integration. If the
tracker has projects, overviews, documents, issues, sub-issues, comments, and
relations, users need an operating model that says what belongs in each object
and which operations the integration actually exposes.

Document all four explicitly:

1. Exact supported command recipes for common relationships, such as listing
   project issues and creating an issue or sub-issue in a project.
2. Durable-information placement: project docs explain work, issues execute
   it, comments record events, and messaging carries conversation.
3. A support matrix separating command-supported, human/UI-only, and future
   operations.
4. Agent guardrails: unavailable operations must cause escalation, not invented
   API calls or guessed flags.

Put the complete guide in the integration README and the operational subset in
the agent skill. Summarize and link the boundary from central integration docs.
