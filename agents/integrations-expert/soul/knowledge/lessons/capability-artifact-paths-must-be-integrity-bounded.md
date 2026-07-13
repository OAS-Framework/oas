---
type: Lesson
title: Capability artifact paths must stay inside the integrity boundary
description: Locked capability manifests must not resolve executable or instruction paths outside the artifact whose bytes were hashed.
timestamp: 2026-07-11
---

# Capability artifact paths must stay inside the integrity boundary

A capability lock is not an executable trust boundary if manifest-relative paths can escape the package directory or follow symlinks outside it. Hashing only the package tree while allowing a hook or command such as `../../../mutable.mjs` lets the approved manifest execute bytes that were never covered by the recorded integrity; a fallback to framework-root paths has the same problem for external packages.

For externally acquired packages, resolve skills, injections, hooks, and commands through a helper that verifies the real target path remains beneath the real package root. Either reject symlinks that escape or include their actual target bytes in the locked artifact. Bundled framework packages may need an explicit trusted exception for intentional shared/hoisted resources, but that exception must not apply to external packages.
