# Knowledge Log

## 2026-07-26
* **Creation**: [prototype-safe-policy-map-lookups](/lessons/prototype-safe-policy-map-lookups.md) records that plain-object policy registries need Object.hasOwn-based membership helpers so inherited Object.prototype names cannot impersonate configured entries.
* **Creation**: [restore-preflight-visible-chain](/lessons/restore-preflight-visible-chain.md) records that restore must strictly parse the full visible lock chain before fetching, staging, or swapping artifacts so malformed inner locks cannot fail after outer mutations.
* **Update**: [package-engine-implementation-gotchas](/lessons/package-engine-implementation-gotchas.md) links package restore gotchas to the visible-lock-chain preflight lesson.
* **Creation**: [local-path-policy-before-expansion](/lessons/local-path-policy-before-expansion.md) records that local-path dependency policy must classify tilde/relative spellings before expansion so remote package metadata cannot bypass no-local-base guards.
* **Update**: [package-engine-implementation-gotchas](/lessons/package-engine-implementation-gotchas.md) links the package gotcha list to the local-path policy-before-normalization lesson.
* **Creation**: [symlink-containment-walker-throws](/lessons/symlink-containment-walker-throws.md) records the recursive symlink walker lesson: broad lstat probe catches can swallow deeper path-escape throws, so guards must be narrowed and real npm `file:` symlink layouts must be tested.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the real `npm ci` `file:` symlink fixture shape for symlink-containment walker regressions.
* **Fix**: [package-runtime-boundary-structured-cli](/decisions/package-runtime-boundary-structured-cli.md) superseded its pre-ruling draft — the recorded surface (packageRuntimeApi probe field, agent show/upsert, spawn --instance/--ephemeral, config get) was maintainer-REJECTED; the decision now records the ruled minimal surface (capability-defined agents, OAS_SETTINGS dispatch, OAS_CLI_BIN, floor+fixture versioning) and the index entry was corrected (reviewer-3f39f2b finding).

## 2026-07-26
* **Update**: [strict-curriculum-scoping](/references/strict-curriculum-scoping.md) merges the maintainer ruling ledger for strict-curriculum sequencing, Claude spike evidence, AGENTS.md loading semantics, and parity gates.
* **Creation**: skills/stale-verification-loop — adds the commit-anchored evidence protocol for coordinator loops that re-verify stale commits and request already-landed work.
* **Creation**: [coordinator-stale-verification-loop](/lessons/coordinator-stale-verification-loop.md) records that stale-verification coordination loops should be answered with branch-head, ancestry, blob-at-head evidence, and explicit ACK references.
* **Creation**: [deps-integrity-trust-binding](/lessons/deps-integrity-trust-binding.md) records the reviewer-caught node_modules trust bypass and the depsIntegrity fix pattern for package approval, restore, and staging materialization.
* **Update**: [package-engine-implementation-gotchas](/lessons/package-engine-implementation-gotchas.md) corrects package trust carry-over to require depsIntegrity and records contract-signature regression testing against the frozen doc.
* **Update**: [per-capability-npm-locks](/decisions/per-capability-npm-locks.md) points the node_modules exclusion boundary at the depsIntegrity trust-binding lesson.
* **Creation**: [strict-curriculum-scoping](/references/strict-curriculum-scoping.md) records launch-path facts for strict instance curriculum enforcement across pi `--no-skills`, Claude Code isolation, spawn-probe sequencing, and `instance.json` provenance.
* **Creation**: [flat-single-capability-packages](/decisions/flat-single-capability-packages.md) records the package layout decision that `capabilities: ["."]` is supported only as the sole capability entry, with whole-tree package integrity and realpath-deduped npm materialization roots.
* **Creation**: [per-capability-npm-locks](/decisions/per-capability-npm-locks.md) records the npm materialization decision: package root plus declared capability dirs with both `package.json` and `package-lock.json` run independent `npm ci --ignore-scripts` units.
* **Update**: [package-engine-implementation-gotchas](/lessons/package-engine-implementation-gotchas.md) records that empty npm closures may create no `node_modules` directory, so materialization probes should test resource path resolvability.
* **Creation**: [package-runtime-boundary-structured-cli](/decisions/package-runtime-boundary-structured-cli.md) records the package-runtime boundary decision: official packages use structured `oas` CLI JSON envelopes and a `packageRuntimeApi` probe, not a blessed kernel module export.
* **Creation**: [package-engine-implementation-gotchas](/lessons/package-engine-implementation-gotchas.md) records package-engine implementation gotchas around dependency-free YAML config shape, file:// local git pins, spawnInstance agent objects, hook meta, package integrity, trust carry-over, and lockfile v2 preservation.
* **Creation**: [frozen-interface-first-delivery](/lessons/frozen-interface-first-delivery.md) records the package-engine contract lesson: unblock sibling workstreams with a schema-plus-contract-doc commit before implementation.
* **Fix**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) scopes the top-level/no-lineage default to non-attached manual spawns, preserving attached owner auto-binding as the explicit exception.
* **Fix**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) now states the complete child/sibling/parent/unrelated lineage matrix, `--parent` child sugar, and attached auto-binding without a stored relation value.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) records the final human/maintainer-accepted concurrency limitations and the decision not to add a lineage transaction subsystem.
* **Update**: root index makes the attached-child decision, final relation architecture, and nonexistent team-root lesson reachable.

## 2026-07-25
* **Update**: [canonical-worktree-verification](/lessons/canonical-worktree-verification.md) merges capture-canonical-path-before-hooks: capture the canonical worktree path immediately after `git worktree add`, retain it through hooks and compensation, and fail closed when no retained identity exists.
* **Update**: [rollback-probes-argv-and-fail-closed](/lessons/rollback-probes-argv-and-fail-closed.md) points worktree rollback probes at the retained canonical identity instead of rollback-time re-canonicalization or lexical fallback.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the symlinked-root, retire-hook-removes-work, stale canonical worktree-list fixture for retained-path rollback coverage.
* **Creation**: [canonical-worktree-verification](/lessons/canonical-worktree-verification.md) records the symlink canonicalization rollback gotcha: capture `realpath(work)` before removal and compare exact NUL-delimited `git worktree list --porcelain -z` records.
* **Update**: [rollback-probes-argv-and-fail-closed](/lessons/rollback-probes-argv-and-fail-closed.md) links the general argv-safe, fail-closed rule to exact canonical worktree record parsing.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the symlinked-agents-root regression fixture for canonical Git worktree rollback diagnostics.
* **Creation**: [rollback-probes-argv-and-fail-closed](/lessons/rollback-probes-argv-and-fail-closed.md) records that public refs in rollback probes must be argv-safe and that unverifiable cleanup probes are incomplete, not absent.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the malicious-ref rollback probe test and the exact-edit/stash rule for temporary bug simulations.
* **Update**: [cross-instance-writes-commit-last](/lessons/cross-instance-writes-commit-last.md) records structured failure channels and effect verification for hook, tmux, and git rollback cleanup truthfulness.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records stateful tmux and pinned-worktree recipes for exercising swallowed failures, silent successes, and cleanup effect checks.
* **Update**: [cross-instance-writes-commit-last](/lessons/cross-instance-writes-commit-last.md) records truthful rollback diagnostics: collect cleanup failures, verify effects, and report incomplete cleanup without masking the original error.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the read-only-retire-hook recipe for forcing scaffold-home removal failure and asserting the incomplete-rollback diagnostic plus remaining home.
* **Update**: [cross-instance-writes-commit-last](/lessons/cross-instance-writes-commit-last.md) records that rollback cleanup steps must each be independently guarded so one cleanup failure cannot skip later compensation or mask the original error.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the temp-path directory recipe for proving rollback continues after a cleanup step itself throws.
* **Update**: [cross-instance-writes-commit-last](/lessons/cross-instance-writes-commit-last.md) merges the rollback completeness checklist: atomic temp+rename metadata writes, retire-hook compensation for capability state, and cleanup of launched/scaffolded side effects.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the launched-path rollback test recipe with a recording fake tmux, forced atomic write failure, hook assertions, and PATH tool symlinks.
* **Update**: [cross-instance-writes-commit-last](/lessons/cross-instance-writes-commit-last.md) records that final cross-instance metadata writes are themselves fallible and need compensation for prior launch/scaffold side effects.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the chmod recipe for forcing metadata-write failures and asserting full rollback.
* **Update**: [kernel-validation-before-side-effects](/lessons/kernel-validation-before-side-effects.md) links to the cross-instance write ordering lesson as the transactionality counterpart to pre-side-effect validation.
* **Creation**: [cross-instance-writes-commit-last](/lessons/cross-instance-writes-commit-last.md) records that writes to another instance's metadata must wait until every remaining fallible step has succeeded, or be compensated on failure.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records direct-kernel coverage for raw spawn relation option combinations, matching CLI `E_BAD_ARGS` cases and no-home side-effect assertions.
* **Update**: [kernel-validation-before-side-effects](/lessons/kernel-validation-before-side-effects.md) records that raw `spawnInstance` option combinations must be validated before relation sugar expansion or explicit-none normalization.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records that name-resolution tests need local-soul fixtures because overlapping discovery phases only double-count there.
* **Update**: [lineage-edge-ambiguity-posture](/lessons/lineage-edge-ambiguity-posture.md) records canonical-home de-duplication before treating all-match enumeration results as intra-root duplicates.
* **Creation**: [overlapping-instance-home-scans-dedupe](/lessons/overlapping-instance-home-scans-dedupe.md) records the `findInstanceHomes` lesson that overlapping `listAgents`/`localAgentBases` scans must dedupe local souls by canonical home.
* **Creation**: [release-bump-pr-org-policy-block](/lessons/release-bump-pr-org-policy-block.md) records the v0.18.3 org-policy block on Actions-created PRs and the publication-first manual rescue path.
* **Update**: skills/aweb-trust-mismatch — adds the read-only diagnostic and independent-confirmation protocol for aweb `identity_mismatch` messages with green doctors.
* **Creation**: [aweb-identity-mismatch-recipient-cache](/lessons/aweb-identity-mismatch-recipient-cache.md) records that persistent `identity_mismatch` with all-green sender and recipient doctors is a recipient-side cache or verification defect, not automatic compromise.
* **Creation**: [desktop-server-global-cli-spawn-test](/lessons/desktop-server-global-cli-spawn-test.md) records the local desktop-server spawn test false failure when a compatible global `oas` CLI is installed.
* **Update**: [release-workflow-static-tests](/lessons/release-workflow-static-tests.md) records mac installer verifier run-block extraction and the exact historical `unsigned` wording carve-out.
* **Update**: [lineage-edge-ambiguity-posture](/lessons/lineage-edge-ambiguity-posture.md) records the inherited-edge two-root validation rule and the need to reject intra-root duplicate instance names that no root qualifier can disambiguate.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) records the spawn validation boundary for copied lineage names and intra-root duplicate anchor matches.
* **Creation**: [lineage-edge-ambiguity-posture](/lessons/lineage-edge-ambiguity-posture.md) records that bare-name lineage edges must enumerate candidates, disambiguate with `--relative-root`/`o.relativeRoot` when needed, and verify both forward and reverse recorded edges from their consumer roots.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) points relation anchor validation at the lineage-edge ambiguity posture, including the reverse edge for parent relations.
* **Creation**: [team-agent-roots-nonexistent-roots](/lessons/team-agent-roots-nonexistent-roots.md) records that nonexistent `teamAgentRoots()` entries are anchors for `localAgentBases(root)` and must survive failed realpath normalization.
* **Update**: [team-scope-and-cross-repo-spawn](/lessons/team-scope-and-cross-repo-spawn.md) clarifies that team roots are not existence-filtered because all-local member scopes may only have `local-agents/`.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) points retire-splice scanners at the nonexistent-roots fallback rule.
* **Creation**: [path-first-resolution-round-trip](/lessons/path-first-resolution-round-trip.md) records the path-first, name round-trip rule for path-identified instances whose metadata stores names.
* **Update**: [names-are-not-identity](/lessons/names-are-not-identity.md) distinguishes path-first owner matching from name-based identity and adds the symlinked checkout matching gotcha.
* **Update**: [attached-spawns-child-of-work-owner](/decisions/attached-spawns-child-of-work-owner.md) records that explicit parent fallback cannot bypass a failed known-instance owner round trip.
* **Update**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) updates attached-mode owner verification to scan paths before accepting the recordable parent name.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) replaces realpath-only attached owner inference with path-first matching and name round-trip verification.
* **Creation**: [names-are-not-identity](/lessons/names-are-not-identity.md) records that bare instance names and path-shaped work owners must resolve to canonical homes before relation repair or attached-owner inference acts.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) clarifies retire splice proof: resolve lineage names from each referrer's context and realpath-match before relinking.
* **Update**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) records that attached work owner fallback is canonical only when an instance's work realpath matches the workDir; non-instance trees need explicit parent.
* **Update**: [attached-spawns-child-of-work-owner](/decisions/attached-spawns-child-of-work-owner.md) clarifies that attached ownership is verified, not inferred lexically from `<name>/work`.
* **Creation**: [attached-spawns-child-of-work-owner](/decisions/attached-spawns-child-of-work-owner.md) records the human decision that attached work mode always makes the attached agent a child of the work-tree owner and rejects contradictory relation flags.
* **Update**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) clarifies that attached-mode parentage is a binding lineage source, not a negatable fallback.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) records attached-mode relation rejection and complete cross-type, team-wide retirement splice rules.
* **Update**: [relation-policy-migration-and-retire-splice](/lessons/relation-policy-migration-and-retire-splice.md) generalizes lineage repair ownership to both sides of lifecycle events across the scope where references can be created.
* **Creation**: [relation-policy-migration-and-retire-splice](/lessons/relation-policy-migration-and-retire-splice.md) records that relation policy changes must migrate all agent-facing spawn recipes and define retire-time repair for mutated lineage.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) records retireInstance splice repair and its `relinked[]` reporting for links pointing at a retiree.
* **Update**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) broadens the recipe migration rule from spawn semantics to relation policy changes.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records that CLI-layer regressions need CLI-surface tests, and that briefly reintroducing the original bug can prove the test has teeth.
* **Creation**: [kernel-validation-before-side-effects](/lessons/kernel-validation-before-side-effects.md) records that rejectable `spawnInstance` relation and anchor options must validate before mkdir/hooks, and that explicit unrelated must survive normalization until fallback handling.
* **Update**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) clarifies explicit unrelated normalization and kernel-side pre-scaffold anchor validation.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records that rejected spawn option tests must assert no instance directory remains.
* **Creation**: [spawn-relations-lineage-fields](/architecture/spawn-relations-lineage-fields.md) records how `oas spawn --relation` maps child, sibling, parent, and unrelated relations onto sparse `parentInstance`/`siblingInstance` metadata and where validation belongs.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records `--json` spawn failure assertion discipline and the clean-checkout need to install dependencies in both the repo root and `packages/desktop` before desktop tests.
* **Creation**: [exact-tag-detached-head-refspec](/lessons/exact-tag-detached-head-refspec.md) records that exact-tag release checkout leaves detached HEAD, so version-bump pushes need fully-qualified `HEAD:refs/heads/...` destinations and static regression coverage.

## 2026-07-24
* **Update**: [test-conventions](/playbooks/test-conventions.md) records that capability fixtures under `.agents/capabilities/` need an `oas-config.yaml` discovery level or tests can accidentally assert `E_UNKNOWN_COMMAND`.
* **Update**: [json-envelope-dispatch-boundary](/lessons/json-envelope-dispatch-boundary.md) records the whole-dispatch try/catch pattern, `NOT_DISPATCHED` sentinel, manifest command validation, and stable dispatcher failure codes.
* **Update**: [release-tag-driven-ci](/playbooks/release-tag-driven-ci.md) records idempotent same-tag retry rules for npm publication and GitHub Release asset publication.
* **Update**: [release-workflow-static-tests](/lessons/release-workflow-static-tests.md) records the static-test blind spot around nonexistent package scripts and the need for spawned script tests plus mutation checks.
* **Creation**: [json-envelope-dispatch-boundary](/lessons/json-envelope-dispatch-boundary.md) records that capability `--json` envelope contracts must cover dispatcher failures, spawn errors, module initialization, and end-to-end dispatch tests.
* **Creation**: [release-workflow-static-tests](/lessons/release-workflow-static-tests.md) records the static node:test pattern for pinning GitHub Actions release workflow sequencing and exact-tag guarantees by asserting string positions and regexes over raw YAML.
* **Creation**: [json-mode-cli-contract](/lessons/json-mode-cli-contract.md) records the stdout-envelope/stderr-progress discipline required by machine-readable CLI modes such as Desktop API v1 `oas spawn --json`.
* **Update**: [test-conventions](/playbooks/test-conventions.md) records the real-tmux idempotence rule: unique instance slugs and cleanup for tests that launch tmux windows.
* **Update**: AGENTS.md — stale surface-consumer reference (oas.web, the TUI) updated to the desktop app's bundled server (desktop succession). Edit authorized by dev-coordinator-1.

* **Creation**: [caller-controlled-instance-name-containment](/lessons/caller-controlled-instance-name-containment.md) records the traversal fix: validate caller-supplied instance names and confirm realpath containment before using by-name instance paths.
* **Creation**: [capability-source-edits-require-lock-refresh](/lessons/capability-source-edits-require-lock-refresh.md) records that marketplace capability source edits require a package version bump, lock refresh, and clean-clone install/test verification.
* **Update**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) records that lineage is deployment-local and cross-deployment spawn recipes must not pass `--parent`.
* **Update**: [capability-defined-agents](/architecture/capability-defined-agents.md) records that by-name instance lookups must use `findInstanceHome(root, name)` so capability-agent homes under `local-agents/<name>/instances/` are included.
* **Update**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) records the grep-all-Markdown rule for migrating agent-facing `oas spawn` recipes when spawn semantics change.
* **Creation**: [spawn-lineage-explicit-only](/decisions/spawn-lineage-explicit-only.md) records explicit-only spawn parentage and adds the Decisions section to the bundle index.
* **Creation**: [task-flag-boolean-crash](/lessons/task-flag-boolean-crash.md) records the missing value-carrying flag boolean foot-gun behind the `--task` spawn crash.

## 2026-07-21

- Seeded the starter bundle from the founding oas-expert sessions and the
  kernel/CLI source: 5 architecture concepts (kernel/CLI shape, config
  cascade, work modes incl. workspace, capability-defined agents, model
  preference lists), 3 lessons (marketplace trust + hoisted paths,
  init-before-config gotcha, team scope + cross-repo spawn), 2 playbooks
  (tag-driven release, test conventions), and a reference to the oas-expert
  decision records.
