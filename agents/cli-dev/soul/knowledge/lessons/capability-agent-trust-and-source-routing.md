---
type: Lesson
title: Capability-agent prompts require provider integrity trust
description: Declaration and path containment do not authenticate capability-agent instructions; verify locked source/dependency integrity before reading soul files, while not requiring executable command approval.
tags: [security, agents, trust, packages, cli]
timestamp: 2026-07-26
---

# Capability-agent trust and source routing

Reviewer-d45641e found that capability-defined agents resolve from declaration,
not active config, and had bypassed `resolveOasConfig` trust. Containment
prevents path escape but does not authenticate bytes inside the package. Before
reading or returning an agent soul tree, verify package/capability lock integrity
and dependency-closure integrity. Instruction-only agents do not need
command/hook executable approval. This sharpens the trust side of
[capability-defined agent resolution](/architecture/capability-defined-agents.md)
and the [depsIntegrity trust binding](/lessons/deps-integrity-trust-binding.md).

The same review clarified acquisition source routing: a remote Git root can be
either a distribution package (`oas-package.json`) or the documented legacy
standalone capability (`oas.json`). Probe package acquisition transactionally and
fall back only on the specific missing-package-manifest error; all other package
errors fail closed.

Update identity must compare the resolved root identity directly with the
expected package, not merely find that ID somewhere in its dependency closure.
Parser `normalized` output is public API and must exactly match the lock form,
including no trailing `@` for bare catalog IDs. Keep these package-engine
gotchas alongside the broader [package implementation gotcha list](/lessons/package-engine-implementation-gotchas.md).
