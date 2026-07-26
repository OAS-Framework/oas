---
type: Lesson
title: Package config profiles are validated config source material, not capabilities
description: Package profile validation reuses the kernel's config-shape validator by exporting validateConfigShape from loadLevelConfig, so profiles fail with the exact errors a live config would, while all package-only checks (dependency closure supply, layer agreement, scope-escape paths) live in lib/packages.mjs.
tags: [packages, profiles, config, validation]
timestamp: 2026-07-26
---

# Lesson

A config profile for `oas init --package` is config source material, so its
schema validity must use the same check as `loadLevelConfig`. The implementation
refactored the inline validation in `lib/core.mjs` into an exported
`validateConfigShape(cfg, file)` and calls it from `validateProfile()` in
`lib/packages.mjs`.

This keeps one source of truth for config-key, entry-key, and renamed-key rules.
Profile-only rules stay in the package module: capabilities supplied by the
package and dependency closure, layer agreement with the package's own
capability `oas.json`, agent-type syntax, injection-override and setup path
containment, and rejection of `from: path:` in profiles. When a dependency
supplies a capability by id, validation must still fetch the provider manifest
before enforcing layer agreement; identifier-only validation let a profile bind
a dependency-supplied capability to the wrong exclusive layer and still
snapshot.

A failing profile returns error strings and the CLI refuses to write the
snapshot. Profile validation therefore happens before side effects, matching the
kernel-side validation lesson in
[kernel-validation-before-side-effects](/lessons/kernel-validation-before-side-effects.md).
