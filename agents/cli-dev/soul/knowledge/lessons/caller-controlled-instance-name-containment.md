---
type: Lesson
title: Caller-controlled instance names need charset validation and realpath containment
description: findInstanceHome must reject names outside the instance-name charset and verify a realpath-resolved hit is the named immediate child of instances/ before any kernel function uses a caller-supplied instance name as a path.
tags: [security, traversal, kernel, lookup, findInstanceHome]
timestamp: 2026-07-24
---

# Lesson

Maintainer reproduced that `oas retire ../../dev/soul` existence-matched via
`join(agentDir, "instances", name)` and recursively deleted the canonical
soul; `oas spawn --parent ../../dev/soul` also recorded malformed lineage.
`existsSync` on a joined caller-controlled path is not a containment check.

The hardening pattern lives in `findInstanceHome`, the shared by-name instance
lookup: reject names not matching the instance-name charset
`^[a-z0-9][a-z0-9-]*$`, then `realpath` the hit and require
`dirname(real) === realpath(instancesDir)` and `basename(real) === name`.
Every kernel function that turns a caller-supplied name into a path must do
both steps; spawn, retire, and status funnel through `findInstanceHome`, and
new lookups must too instead of using raw `join` plus `existsSync`.

Related: [capability-defined agents](/architecture/capability-defined-agents.md)
records why by-name instance lookups should use `findInstanceHome` rather
than ad hoc agent scans.
