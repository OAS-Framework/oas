---
type: Lesson
title: Verify through the exact executable and scope the session will use, not the canonical one
description: Claude plugin checks ran through the literal `claude` while sessions launch with the oas-claude-config wrapper, and parsed human output that drops plugin scope — so a different account's or another project's plugin could satisfy a requirement.
tags: [claude-code, capabilities, requirements, verification, fail-closed]
timestamp: 2026-07-27
---

# Lesson

A preflight check is only meaningful if it inspects **the same thing the session will
use**. Two ways that broke at once when extending runtime requirements to Claude:

## The executable is context-selected

`resolveClaudeBinary(contextDir)` reads `oas-claude-config`, which may name a wrapper —
`claude-personal` in this deployment. Probing and install-planning went through the literal
`claude`. Separate account wrappers have separate plugin sets, so the default account could
hold the plugin, preflight would pass, and the instance would launch on the wrapper with no
channel. The reverse rejects a perfectly good setup.

Rule: resolve the runtime executable for the target context ONCE, and use that same value
for detection, for the install plan, and for the remedy text you print.

## Scope is part of the answer

`claude plugin list` (human) prints id, version, scope and status but the parser kept only
id and enabled. `--json` carries `scope`, `projectPath` and `installPath`. Without scope, a
plugin installed **for an unrelated project** satisfies a user-level requirement globally —
demonstrable on this machine, where `frontend-design@claude-plugins-official` exists
project-scoped for two different projects AND user-scoped.

Rule: a user-scope install applies everywhere; a project/local install applies only inside
its own project. Prefer a runtime's `--json` output over its human output whenever a
decision depends on a field — human output is a rendering, and renderings drop things.

## Every consumer of the context needs it, or the fix is cosmetic

The context-selected executable is needed in THREE places: detection, install planning, and
post-install verification. Fixing the first two left the defect fully intact from the
operator's point of view — the install ran through `claude-personal` and was then verified
against `claude`, reporting a successful install as failed (or a failed one as successful)
purely by which account happened to hold the plugin.

When threading a resolved value through a subsystem, enumerate its consumers and fix them
together. A partially-threaded context is indistinguishable from an unthreaded one wherever
the two disagree, which is exactly the case the value existed to handle.

## Related: conflict keys must cover the whole plan

When an install plan became a SEQUENCE (register a marketplace, then install), conflict
detection still keyed on the final command. Two capabilities requiring the same
`plugin@marketplace` from DIFFERENT marketplace sources merged silently, and whichever was
seen first decided which third-party source got registered. Key on the full ordered
sequence, and show every step at the consent prompt.

See also [runtime contract lesson](/lessons/runtime-contract-not-resolution-internals.md) (ask the runtime) and
[runtime-package requirements](/lessons/runtime-package-requirements.md).
