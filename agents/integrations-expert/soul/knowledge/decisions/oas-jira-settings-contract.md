---
type: Decision
title: oas-jira settings contract — site/project via OAS_SETTINGS + spawn brief
description: How the Jira integration parameterizes site/project without hardcoding, and how agents discover them.
tags: [oas-jira, settings, tasks-layer]
timestamp: 2026-07-10
---

Contract: target settings on the canonical `capabilities.oas.jira` binding
carry `{ site, project }` in `oas-config.yaml`.

Flow: the kernel puts the settings JSON in `OAS_SETTINGS` for hooks
(lib/core.mjs:537) → oas-jira's spawn hook writes a
`Tasks: Jira — project <KEY> on <site>` brief line into TASK.md and persists
`{label, site, project}` under `capabilityMeta["oas.jira"]` in instance.json. The skill tells
agents to find site/project via (1) TASK.md brief, (2) `oas doctor --json`,
(3) ask the human — and to STOP if unset, never guess.

The spawn hook is advisory-only (no Jira calls, no auth attempt): incomplete
settings emit a `warning` (surfaced to the spawner) but still produce a
brief. No retire hook — nothing to clean up; roster retirement is a
skill-level protocol, not a hook.
