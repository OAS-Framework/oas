---
type: Lesson
title: Capability manifest compatibility floor must cover core APIs
description: When oas-web starts calling a new core.* helper, capabilities/oas-web/oas.json compatibility.oas must be raised to the kernel version that helper first shipped in, and the manifest-floor regression test's API map should be extended with that helper.
tags: [oas-web, compatibility, manifest, kernel, gotcha]
timestamp: 2026-07-22
---

# The contract

`capabilities/oas-web/oas.json` `compatibility.oas` is a real runtime
contract: an installed `oas.web` capability may run against any kernel version
that satisfies the declared floor.

# The failure mode

If the server calls a `core.*` helper newer than the manifest floor, accepted
older kernels can fail in non-obvious ways. The observed case was
`listCapabilityAgents` / `findCapabilityAgent`, which first shipped in kernel
`0.16.0` while the manifest still accepted `>=0.14.0`; affected panels either
silently missed agents or returned 409 responses wrapping a `TypeError`.

# Maintenance rule

When `bin/oas-web.mjs` starts using another core API:

1. Find the helper's first kernel version with `git log --all -S <name> -- lib/core.mjs`.
2. Raise `compatibility.oas` in `capabilities/oas-web/oas.json` to cover that version.
3. Extend the `api -> minimum kernel version` map in the
   `oas-web manifest: compatibility floor covers the core APIs the server uses`
   test in `test/oas-web.test.mjs`.

# Related concepts

- [Dev loop — version bumps and the marketplace refresh dance](/playbooks/dev-loop-and-marketplace-refresh.md)
