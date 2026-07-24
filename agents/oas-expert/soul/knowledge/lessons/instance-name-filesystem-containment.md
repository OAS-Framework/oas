---
type: Lesson
title: Instance-name filesystem lookups must reject path traversal before joining
description: Any helper that maps an instance-name argument to an instance home must validate the name and enforce immediate-child containment before filesystem existence checks or destructive lifecycle operations.
tags: [security, filesystem, instances, validation]
timestamp: 2026-07-24
---

# Instance-name filesystem lookups must reject path traversal before joining

An instance lookup that loops agent directories and checks `existsSync(join(agentDir, "instances", userName))` does not prove that `userName` is an instance. Dot segments can escape `instances/` and make another existing directory look like an instance home. If the helper feeds metadata, malformed hierarchy is accepted; if it feeds retirement, recursive deletion can remove a canonical soul or another arbitrary reachable directory.

Validate instance-name syntax before joining, reject path separators and dot segments, and verify that the resolved candidate is an immediate child of the intended `instances/` directory. Destructive callers should share the same hardened lookup. Regression tests should cover both a read/validation caller and the destructive lifecycle caller, asserting traversal is rejected before scaffolding or deletion.
