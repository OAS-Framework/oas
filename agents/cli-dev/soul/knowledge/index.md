---
okf_version: "0.1"
---

# cli-dev knowledge base

Curated long-term knowledge for the cli-dev agent — the OAS kernel
(lib/core.mjs) and CLI (bin/oas.mjs) developer. Follow links selectively —
read what the current task needs, not everything.

# Sections

## Decisions

* [decisions/spawn-lineage-explicit-only.md](decisions/spawn-lineage-explicit-only.md) - parentInstance now comes only from an explicit relation/--parent inside the target deployment or the attached-mode owner binding; env vars are never consulted, and cross-deployment spawns stay operator-origin.
* [decisions/attached-spawns-child-of-work-owner.md](decisions/attached-spawns-child-of-work-owner.md) - attached work mode always makes the new agent a child of the verified work-tree owner; contradictory relations are rejected.

## Architecture

* [architecture/kernel-and-cli-shape.md](architecture/kernel-and-cli-shape.md) - the kernel/CLI split, agents-root layout, and the dependency-free YAML subset.
* [architecture/config-cascade-closest-wins.md](architecture/config-cascade-closest-wins.md) - how resolveOasConfig walks the config chain with closest-declaration-wins semantics, and its validation gotchas.
* [architecture/work-modes-and-workspace-mode.md](architecture/work-modes-and-workspace-mode.md) - the four work modes, packaged briefings as the contract, and workspace mode's boundary requirement and no-branch semantics.
* [architecture/capability-defined-agents.md](architecture/capability-defined-agents.md) - manifest `agents:` souls resolving on declaration, and the _dir/_soulDir split for instance homing.
* [architecture/model-preference-lists.md](architecture/model-preference-lists.md) - comma-separated model preferences probed via `pi --list-models` with first-entry fallback.
* [architecture/spawn-relations-lineage-fields.md](architecture/spawn-relations-lineage-fields.md) - final child/sibling/parent/unrelated semantics, sparse lineage fields, attached-owner binding, ambiguity validation, and retirement splice behavior.

## Lessons

* [lessons/caller-controlled-instance-name-containment.md](lessons/caller-controlled-instance-name-containment.md) - findInstanceHome must reject names outside the instance-name charset and verify a realpath-resolved hit is the named immediate child of instances/ before any kernel function uses a caller-supplied instance name as a path.
* [lessons/marketplace-trust-and-hoisted-paths.md](lessons/marketplace-trust-and-hoisted-paths.md) - marketplace-over-bundled migration: trust at acquisition and the lock-sourced hoisted-path exemption.
* [lessons/init-acquires-before-config-exists.md](lessons/init-acquires-before-config-exists.md) - mid-init the config chain cannot rediscover a just-acquired capability; use the acquisition result directly.
* [lessons/team-scope-and-cross-repo-spawn.md](lessons/team-scope-and-cross-repo-spawn.md) - team boundary scan, cross-repo spawn as a CLI resolution change, and why instance lookups stay local-first.
* [lessons/team-agent-roots-nonexistent-roots.md](lessons/team-agent-roots-nonexistent-roots.md) - teamAgentRoots deliberately retains nonexistent agents/ anchors for all-local sibling scopes; deployment-wide scans must not existence-filter them away.
* [lessons/task-flag-boolean-crash.md](lessons/task-flag-boolean-crash.md) - bin/oas.mjs flag() yields boolean true when the next argv token starts with "--"; oas spawn dev --task --purpose x passed task=true into spawnInstance and crashed mid-scaffold at task.trim(), while task delivery itself was never broken.
* [lessons/capability-source-edits-require-lock-refresh.md](lessons/capability-source-edits-require-lock-refresh.md) - edits under capabilities/<pkg>/ change capabilityIntegrity, so clean-clone CI fails restore unless the package version and matching oas-lock.json source/version/integrity are refreshed in the same commit.
* [lessons/json-mode-cli-contract.md](lessons/json-mode-cli-contract.md) - when a CLI command grows a machine-readable --json mode for an external consumer, success and failure must be one stdout JSON envelope with stable error codes, and all human progress prose must move to stderr in JSON mode.
* [lessons/json-envelope-dispatch-boundary.md](lessons/json-envelope-dispatch-boundary.md) - A capability command's --json envelope guarantee is void unless the generic CLI dispatcher wraps the whole dispatch path, including manifest discovery, trust checks, command decoding, non-match fallthrough, and child spawn failures.
* [lessons/release-workflow-static-tests.md](lessons/release-workflow-static-tests.md) - A cheap, robust way to regression-test a GitHub Actions release workflow's binding ordering guarantees is a node:test file over raw YAML, but run-block extraction and wording guards need precise slices and documented historical exceptions.
* [lessons/desktop-server-global-cli-spawn-test.md](lessons/desktop-server-global-cli-spawn-test.md) - test/desktop-server.test.mjs can fail locally with 409 instead of the expected cli-unavailable 503 when a compatible global oas CLI is installed, because the desktop server resolves the real CLI and never enters the unavailable-adapter path.
* [lessons/aweb-identity-mismatch-recipient-cache.md](lessons/aweb-identity-mismatch-recipient-cache.md) - When aweb mail arrives as trust_status=identity_mismatch but read-only doctors pass on both sender and recipient, treat it as a recipient-side cached-key or verification defect rather than evidence of compromise.
* [lessons/exact-tag-detached-head-refspec.md](lessons/exact-tag-detached-head-refspec.md) - Switching a release workflow checkout from main to github.sha preserves exact-tag integrity but leaves the runner in detached HEAD, so version-bump pushes must use a fully-qualified destination such as HEAD:refs/heads/<branch>.
* [lessons/release-bump-pr-org-policy-block.md](lessons/release-bump-pr-org-policy-block.md) - A release can publish npm and GitHub Release successfully while the final version-bump PR is blocked by org policy, so publication-first ordering keeps the release live and leaves only manual PR rescue.
* [lessons/kernel-validation-before-side-effects.md](lessons/kernel-validation-before-side-effects.md) - spawnInstance options that can be rejected (relations, anchors, relation sugar conflicts) must be checked in their raw caller shape before normalization and before mkdir/hooks because CLI prechecks do not protect direct kernel callers.
* [lessons/package-profile-validation-config-shape.md](lessons/package-profile-validation-config-shape.md) - Package profile validation reuses the kernel's config-shape validator by exporting validateConfigShape from loadLevelConfig, so profiles fail with the exact errors a live config would, while all package-only checks (dependency closure supply, layer agreement, scope-escape paths) live in lib/packages.mjs.
* [lessons/frozen-package-engine-contract-alignment.md](lessons/frozen-package-engine-contract-alignment.md) - When a sibling package-engine workstream freezes an interface, align shared-reader return envelopes, schema-verbatim fixture data, and the shared error-code taxonomy before treating the seam as swappable.
* [lessons/requirement-recipes-data-allowlist.md](lessons/requirement-recipes-data-allowlist.md) - Host-requirement installers are planned by an allowlisted manager table that validates package/formula names against strict regexes and returns argv arrays; consent, execution (execFileSync, no shell), and post-install PATH verification are separate steps so noninteractive fail-safe and per-requirement acceptance flags fall out naturally.
* [lessons/reconciliation-truthfulness-fixes.md](lessons/reconciliation-truthfulness-fixes.md) - Workspace reconciliation must control side effects before reporting: restore each lock level once, fail locked-but-uninstalled v2 package entries, and make consented requirement install failures nonzero.
* [lessons/team-boundary-scan-pruning.md](lessons/team-boundary-scan-pruning.md) - discoverWorkspaceScopes walks the boundary depth-first in sorted path order, pruning fixed directory names (.git, node_modules, vendor, venvs, .agents, local-agents), instances/ dirs that sit next to a soul/, and any child whose oas-config.yaml declares its own team:, which makes nested team boundaries self-owned reconciliation units without any registry.
* [lessons/cross-instance-writes-commit-last.md](lessons/cross-instance-writes-commit-last.md) - Spawn-style operations need late atomic cross-instance metadata writes, rollback that compensates launched/scaffolded side effects, and truthful diagnostics for incomplete cleanup.
* [lessons/rollback-probes-argv-and-fail-closed.md](lessons/rollback-probes-argv-and-fail-closed.md) - Public branch/ref values must never be interpolated into shell probes; cleanup verification needs three outcomes, and unverifiable checks belong in incomplete rollback diagnostics.
* [lessons/canonical-worktree-verification.md](lessons/canonical-worktree-verification.md) - Git canonicalizes symlinked worktree paths, so rollback checks must capture the work realpath immediately after add, retain it through hooks and compensation, and compare exact NUL-delimited worktree records.
* [lessons/names-are-not-identity.md](lessons/names-are-not-identity.md) - Cross-instance references by bare name must be resolved from the referrer's context and realpath-compared before acting; path-identified owners need path-first matching and name round-trip verification before recording.
* [lessons/path-first-resolution-round-trip.md](lessons/path-first-resolution-round-trip.md) - When a path identifies an instance but metadata records a name, search candidate homes by path first and accept the name only if it resolves back to the same home from the consumer's context.
* [lessons/lineage-edge-ambiguity-posture.md](lessons/lineage-edge-ambiguity-posture.md) - Any operation recording or copying a bare-name cross-instance edge needs all-match enumeration, rejection of intra-root duplicates, and round-trip validation from every context that will interpret the stored name.
* [lessons/overlapping-instance-home-scans-dedupe.md](lessons/overlapping-instance-home-scans-dedupe.md) - listAgents(root) already includes local souls from localAgentBases(root), so all-match instance enumerators that also scan localAgentBases for capability fallbacks must dedupe by canonical home or local instances look duplicated.
* [lessons/relation-policy-migration-and-retire-splice.md](lessons/relation-policy-migration-and-retire-splice.md) - Introducing or changing spawn relation policy must update every agent-facing spawn recipe and repair mutated lineage on both sides, across the full scope where references can be created.

## Playbooks

* [playbooks/release-tag-driven-ci.md](playbooks/release-tag-driven-ci.md) - Releases are cut by pushing a vX.Y.Z tag on main which makes CI bump and publish packages; local version bumps break the workflow, retries must skip already-published artifacts, and verification means installing the published artifact.
* [playbooks/test-conventions.md](playbooks/test-conventions.md) - Kernel and CLI tests run node:test against temp directories with fixture souls, fake/runtime tmux shims on PATH, spawnSync of bin/oas.mjs for CLI behavior, and regression coverage at the layer where bugs occurred.

## References

* [references/oas-expert-decisions.md](references/oas-expert-decisions.md) - pointers to the canonical Decision records and docs governing this area.

Grow role-specific sections beyond these as the agent's role demands — list
them here and log the growth in log.md.
