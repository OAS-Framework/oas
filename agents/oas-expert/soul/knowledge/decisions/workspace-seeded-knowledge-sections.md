---
type: Decision
title: Workspace-seeded knowledge sections (superseded)
description: The pre-contract workspace.yaml knowledge-sections mechanism was removed; knowledge-package settings now own any custom seed behavior.
tags: [memory, okf, workspaces, config, history]
timestamp: 2026-07-11
---

**Status: superseded.** The unpublished implementation let
`.agents/workspace.yaml` name a `knowledge-sections` file whose OKF index lines
were seeded into new souls. Its useful invariants were additive-only extension
and creation-only application, so deployment config could not silently rewrite
an agent-owned bundle.

The first capability-package contract removed both `workspace.yaml` translation
and the `knowledge-sections` key. A knowledge integration may still expose an
explicit package setting for custom scaffold input—for example an OKF binding's
`settings.sections-file`—and its `soul-scaffold` hook owns interpretation. The
kernel remains knowledge-format agnostic.

The general lesson survives: deployment-provided knowledge seeds must not
remove format-required sections or mutate existing agent-owned knowledge.
