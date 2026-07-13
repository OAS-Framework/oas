---
type: Area Guide
title: Workspace config (superseded)
description: Historical .agents/workspace.yaml design, removed before the first public capability-package contract in favor of scoped oas-config.yaml.
tags: [workspaces, config, history]
timestamp: 2026-07-11
---

**Superseded and removed.** The unpublished implementation once read
`<workspace>/.agents/workspace.yaml` for sticky instructions, skill roots,
knowledge-section seeds, and aweb settings. OAS had no external users when the
first capability-package contract was established, so this shape has no
compatibility promise and is no longer discovered or translated.

The current deployment contract is [oas-config](/architecture/oas-config.md):

- unconditional workspace instructions use `agents-md-injection`;
- shared skills and instructions ship in targetable capability packages;
- fundamental integrations activate through `capabilities` bindings;
- package settings live on target bindings; and
- `layers.<layer>: none` is the sole explicit inherited-layer disable.

This historical concept remains only to explain earlier architecture records.
