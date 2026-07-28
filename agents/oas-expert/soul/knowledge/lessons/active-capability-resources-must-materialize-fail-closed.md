---
type: Lesson
title: Active capability resources must materialize completely before launch
description: Spawn must compare every resource declared by active capabilities with the materialized instance curriculum and fail closed with rollback rather than silently omit missing skills, injections, or selected plugins.
tags: [curriculum, capabilities, spawn, skills, plugins, rollback]
timestamp: 2026-07-27
---

# Lesson

A fresh worktree can lack dependency-backed paths referenced by a capability manifest. In one observed spawn, the active messaging capability declared three skills beneath worktree `node_modules`; because dependencies had not yet been installed, composition silently skipped all three while still launching the instance. The agent therefore lacked the exact messaging procedures needed to diagnose and report the problem.

Availability checks must not be implemented as “copy each path that happens to exist.” Spawn already resolves the ordinary scoped OAS config cascade for the target soul and its agent type/family—including specificity, closer-scope precedence, exclusive layers, additive capabilities, exclusions, settings, and overrides. That result is the exact active capability set. Spawn must construct its expected resources from that set and prove complete materialization before launch:

1. Resolve active capability resources from their locked, integrity-verified package or capability source rather than incidental worktree dependency state.
2. Include every declared skill and instruction injection, plus any selected runtime plugin or extension required by the active capability. Materialize each selected skill exactly once as an instance-local copy in canonical `.agents/skills/<name>/`, then create `.claude/skills -> ../.agents/skills`. Assert the physical expected set/digests/provenance and verify the symlink resolves exactly to the contained canonical tree. OAS skills do not travel through a synthetic Claude plugin, divergent duplicate tree, or additional skill directory; selected provider plugins remain a separate declared resource class.
3. Compose every optional instruction injection from those active capabilities, together with kernel, soul, work-mode, and config blocks, into one generated `AGENTS.md`; retain canonical `CLAUDE.md -> AGENTS.md` so both harnesses receive identical instructions rather than divergent copies. Compare expected skills/blocks with the materialized instance set and recorded provenance.
4. If any required resource is absent, invalid, untrusted, or cannot be isolated for the selected runtime, emit a deterministic diagnostic and roll back the entire spawn transaction; never leave a launched session or zombie home.
5. Test fresh Pi and Claude instances from worktrees with no dependency installation, asserting both completeness of active resources and absence of inactive/unassigned resources.

“Every capability the instance has access to” means every capability active for that soul under resolved local config. Merely installed but inactive capabilities must remain outside the curriculum, or complete materialization would reintroduce ambient skill noise.
