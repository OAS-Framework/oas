---
type: Lesson
title: Classic init must read its own capability store directly
description: During oas init no config exists at the target scope yet, so config-chain capability discovery cannot see that scope's installed or owned capability stores; init must consult its own store before the chain.
tags: [cli, init, capabilities, config-chain, capability-materialization]
timestamp: 2026-07-29
---

# The blind spot

`capabilityManifests(startDir)` walks the **config chain**. During `oas init`,
the target scope has no `oas-config.yaml` yet, so that scope is not a chain
level. Its own `.agents/capabilities/installed/` and
`.agents/capabilities/owned/` trees are invisible to chain discovery.

That means a capability already sitting in the target scope can read as unknown,
and a capability materialized earlier in the same init run can be invisible to a
later layer slot in that same run.

# The rule

Classic init must read the target scope's capability store **directly** (the
`ownScopeCapabilityManifests` shape) and consult it before falling back to the
config chain. The direct read covers three durable cases:

- an owned capability authored in place;
- an installed artifact left by a previous acquisition; and
- same-run acquisition visibility when two layer slots are served by one
  materialized package.

Removing this direct read is not a convenience cleanup: in the materialization
work it failed nine of the fifteen focused cases.

# Relationship to earlier init visibility lessons

This is the capability-store version of the same init-time chain-visibility
trap recorded for [mid-init acquisition](/lessons/init-acquires-before-config-exists.md)
and [init-time package locks](/lessons/init-lock-visibility-package-twin.md).
The safe pattern is the same: when init may act before the target scope has a
config file, merge or consult that scope's own on-disk state directly rather
than relying only on chain readers.
