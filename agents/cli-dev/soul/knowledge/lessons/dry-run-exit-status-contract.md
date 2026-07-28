---
type: Lesson
title: Dry-run exit status must match the apply contract for blocked states
description: A dry run that reports a held or otherwise blocked state must exit nonzero when apply would exit nonzero, or automation can read "planned" as "ready".
tags: [cli, json-contract, exit-codes, migration]
timestamp: 2026-07-28
---

# What went wrong

The guided migration dry run treated reporting as success: it exited 0 with
`ok: true` when every scope was held. That contradicted both the apply path,
which exits nonzero for a held scope, and the documented held-is-nonzero
contract.

A consumer scripting the obvious readiness check could therefore misread the
state:

```bash
oas migrate --official --dry-run && oas migrate --official
```

The report existed, but the answer was still "not ready". Exit status was part
of that answer.

# Rule

When a command has preview and apply modes, any state that blocks apply must
block preview with the same exit-status contract. Only side effects differ.
Keep the complete plan available under `error.details` so the nonzero result
loses no information.

If documentation says "X exits nonzero", every command mode must honor it, and
regression tests must assert the exit status, not only the payload. Payload
assertions can pass while the shell contract is wrong.

This is a contract detail for [guided official migration](/decisions/guided-official-migration-shape.md)
and the broader [JSON-mode CLI contract](/lessons/json-mode-cli-contract.md).
