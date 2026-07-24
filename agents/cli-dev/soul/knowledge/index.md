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

* [lessons/caller-controlled-instance-name-containment.md](lessons/caller-controlled-instance-name-containment.md) - findInstanceHome must reject names outside the instance-name charset and verify a realpath-resolved hit is the named immediate child of instances/ before any kernel function uses a caller-supplied instance name as a path.
* [lessons/marketplace-trust-and-hoisted-paths.md](lessons/marketplace-trust-and-hoisted-paths.md) - marketplace-over-bundled migration: trust at acquisition and the lock-sourced hoisted-path exemption.
* [lessons/init-acquires-before-config-exists.md](lessons/init-acquires-before-config-exists.md) - mid-init the config chain cannot rediscover a just-acquired capability; use the acquisition result directly.
* [lessons/team-scope-and-cross-repo-spawn.md](lessons/team-scope-and-cross-repo-spawn.md) - team boundary scan, cross-repo spawn as a CLI resolution change, and why instance lookups stay local-first.
* [lessons/task-flag-boolean-crash.md](lessons/task-flag-boolean-crash.md) - bin/oas.mjs flag() yields boolean true when the next argv token starts with "--"; oas spawn dev --task --purpose x passed task=true into spawnInstance and crashed mid-scaffold at task.trim(), while task delivery itself was never broken.
* [lessons/capability-source-edits-require-lock-refresh.md](lessons/capability-source-edits-require-lock-refresh.md) - edits under capabilities/<pkg>/ change capabilityIntegrity, so clean-clone CI fails restore unless the package version and matching oas-lock.json source/version/integrity are refreshed in the same commit.
* [lessons/json-mode-cli-contract.md](lessons/json-mode-cli-contract.md) - when a CLI command grows a machine-readable --json mode for an external consumer, success and failure must be one stdout JSON envelope with stable error codes, and all human progress prose must move to stderr in JSON mode.
* [lessons/json-envelope-dispatch-boundary.md](lessons/json-envelope-dispatch-boundary.md) - A capability command's --json envelope guarantee is void if the generic CLI dispatcher can fail before the command boundary and print help or stderr instead.
* [lessons/release-workflow-static-tests.md](lessons/release-workflow-static-tests.md) - A cheap, robust way to regression-test a GitHub Actions release workflow's binding ordering guarantees (exact-tag checkout, build-before-publish, GH-Release-after-npm, bump coverage) is a node:test file asserting indexOf ordering and regexes over the raw YAML.

## Playbooks

* [playbooks/release-tag-driven-ci.md](playbooks/release-tag-driven-ci.md) - shipping via the vX.Y.Z tag: never bump locally, probe the published artifact.
* [playbooks/test-conventions.md](playbooks/test-conventions.md) - test/capabilities.test.mjs house style: temp dirs, fixtureSoul, fakeRuntimes, spawnSync of the CLI.

## References

* [references/oas-expert-decisions.md](references/oas-expert-decisions.md) - pointers to the canonical Decision records and docs governing this area.

Grow role-specific sections beyond these as the agent's role demands — list
them here and log the growth in log.md.
