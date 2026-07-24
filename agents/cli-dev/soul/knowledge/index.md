---
okf_version: "0.1"
---

# cli-dev knowledge base

Curated long-term knowledge for the cli-dev agent — the OAS kernel
(lib/core.mjs) and CLI (bin/oas.mjs) developer. Follow links selectively —
read what the current task needs, not everything.

# Sections

## Decisions

* [decisions/spawn-lineage-explicit-only.md](decisions/spawn-lineage-explicit-only.md) - parentInstance now comes only from an explicit --parent/o.parent inside the target deployment or the attached-mode workDir-owner fallback; env vars are never consulted, and cross-deployment spawns stay operator-origin.

## Architecture

* [architecture/kernel-and-cli-shape.md](architecture/kernel-and-cli-shape.md) - the kernel/CLI split, agents-root layout, and the dependency-free YAML subset.
* [architecture/config-cascade-closest-wins.md](architecture/config-cascade-closest-wins.md) - how resolveOasConfig walks the config chain with closest-declaration-wins semantics, and its validation gotchas.
* [architecture/work-modes-and-workspace-mode.md](architecture/work-modes-and-workspace-mode.md) - the four work modes, packaged briefings as the contract, and workspace mode's boundary requirement and no-branch semantics.
* [architecture/capability-defined-agents.md](architecture/capability-defined-agents.md) - manifest `agents:` souls resolving on declaration, and the _dir/_soulDir split for instance homing.
* [architecture/model-preference-lists.md](architecture/model-preference-lists.md) - comma-separated model preferences probed via `pi --list-models` with first-entry fallback.

## Lessons

* [lessons/marketplace-trust-and-hoisted-paths.md](lessons/marketplace-trust-and-hoisted-paths.md) - marketplace-over-bundled migration: trust at acquisition and the lock-sourced hoisted-path exemption.
* [lessons/init-acquires-before-config-exists.md](lessons/init-acquires-before-config-exists.md) - mid-init the config chain cannot rediscover a just-acquired capability; use the acquisition result directly.
* [lessons/team-scope-and-cross-repo-spawn.md](lessons/team-scope-and-cross-repo-spawn.md) - team boundary scan, cross-repo spawn as a CLI resolution change, and why instance lookups stay local-first.
* [lessons/task-flag-boolean-crash.md](lessons/task-flag-boolean-crash.md) - bin/oas.mjs flag() yields boolean true when the next argv token starts with "--"; oas spawn dev --task --purpose x passed task=true into spawnInstance and crashed mid-scaffold at task.trim(), while task delivery itself was never broken.

## Playbooks

* [playbooks/release-tag-driven-ci.md](playbooks/release-tag-driven-ci.md) - shipping via the vX.Y.Z tag: never bump locally, probe the published artifact.
* [playbooks/test-conventions.md](playbooks/test-conventions.md) - test/capabilities.test.mjs house style: temp dirs, fixtureSoul, fakeRuntimes, spawnSync of the CLI.

## References

* [references/oas-expert-decisions.md](references/oas-expert-decisions.md) - pointers to the canonical Decision records and docs governing this area.

Grow role-specific sections beyond these as the agent's role demands — list
them here and log the growth in log.md.
