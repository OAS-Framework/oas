# Knowledge Log

## 2026-08-20
* **Update**: expanded [Post-merge developer harvests land on instance branches — preserve before retiring](/lessons/post-merge-harvest-stranding.md) with attached-parent conflict recovery from `attached-mode-harvest-relation-conflict.md`.
* **Creation**: added [Agent discovery, addressability, and execution are distinct states](/lessons/agent-discovery-addressability-and-execution-are-distinct.md) from `attached-resume-agents-live-under-owner-and-team-scope.md`.
* **Triage**: dropped `bare-node-test-can-discover-agent-worktree-tests.md` because this package-test implementation detail is already maintainer knowledge and does not change coordinator choreography.
* **Triage**: dropped `consumer-gates-must-match-kernel-parser-semantics.md` because parser-parity implementation belongs to package authors and kernel maintainers rather than the coordinator soul.
* **Triage**: dropped `double-quoting-does-not-stop-shell-command-substitution.md` because the shell-safety fix is developer implementation knowledge, not a coordinator procedure or release decision.
* **Triage**: dropped `fixtures-must-reach-the-boundary-they-claim-to-test.md` because fixture falsification is developer/reviewer craft and adds no coordinator-specific behavior.
* **Update**: expanded [Post-merge developer harvests land on instance branches — preserve before retiring](/lessons/post-merge-harvest-stranding.md) with frozen-note custody and zero-source verification from `freeze-note-writes-during-concurrent-harvest.md`.
* **Triage**: dropped `isolation-probes-must-shadow-sibling-host-executables.md` because probe isolation is package-test implementation knowledge rather than coordinator choreography.
* **Triage**: dropped `lexical-path-comparison-is-not-containment.md` because filesystem containment belongs to the package validator's owning developer soul.
* **Triage**: dropped `oas-use-cannot-bootstrap-a-configless-scope.md` because it records a released-0.20 kernel limitation and leaf-package ruling that should remain with package/kernel stewardship.
* **Triage**: dropped `released-020-agent-types-require-mapping-form.md` because it is version-bound package template compatibility knowledge for package authors and kernel maintainers.
* **Triage**: dropped `released-020-doctor-misreads-v2-capability-locks.md` because the released-0.20 diagnosis and publication blocker belong to kernel release stewardship, not durable coordinator behavior.
* **Update**: expanded [Agent discovery, addressability, and execution are distinct states](/lessons/agent-discovery-addressability-and-execution-are-distinct.md) with addressable/executing/blocked health states from `roster-presence-does-not-prove-agent-progress.md`.
* **Triage**: dropped `schema-dispatch-must-use-own-properties.md` because untrusted-dictionary implementation belongs to the validator's owning developer soul.
* **Creation**: added [Human approval remains a separate gate for irreversible releases](/decisions/human-approval-for-irreversible-releases.md) from `technical-gates-do-not-substitute-for-human-release-approval.md`.
* **Triage**: dropped `validate-path-properties-not-known-prefixes.md` because path-property validation and fixture escaping are package implementation details rather than coordinator behavior.
* **Update**: expanded [Merged-state reviewers catch stale-base drift against moving main](/lessons/stale-base-drift-merged-review.md) with fetched-main knowledge-PR scope verification from `verify-knowledge-only-diffs-against-fetched-main.md`.
* **Update**: skills/multi-dev-feature — added workspace-scoped attached-agent health checks, harvest custody/recovery, fetched-main knowledge delivery, and irreversible-release authorization gates from the promoted package-wave notes.

## 2026-07-29
* **Creation**: added [Compose atomic engine operations with an outer command rollback journal](/lessons/compose-atomic-engine-operations-with-an-outer-command-journal.md) from `compose-atomic-engine-operations-with-an-outer-command-journal.md`.
* **Creation**: added [Config synchronization must preserve untouched local bytes](/lessons/config-sync-must-preserve-untouched-bytes.md) from `config-sync-must-preserve-untouched-bytes.md`.
* **Creation**: added [Hashed generated provenance must be replayable across tool upgrades](/lessons/hashed-generated-provenance-must-be-replayable.md) from `hashed-generated-provenance-must-be-replayable.md`.
* **Creation**: added [Legacy resource spelling is not a safe package-format discriminator](/lessons/legacy-format-spelling-is-not-a-safe-compatibility-discriminator.md) from `legacy-format-spelling-is-not-a-safe-compatibility-discriminator.md`.
* **Creation**: added [Node recursive cpSync can bypass JavaScript cleanup on unreadable trees](/lessons/node-recursive-cpsync-can-bypass-javascript-cleanup.md) from `node-recursive-cpsync-can-bypass-javascript-cleanup.md`.
* **Creation**: added [Replace unadopted transitional formats in place instead of versioning compatibility](/lessons/replace-unadopted-transitional-formats-in-place.md) from `replace-unadopted-transitional-formats-in-place.md`.
* **Creation**: added [Transient packages require an exact resource-reader seam for config consumers](/lessons/transient-packages-require-resource-reader-seam.md) from `transient-packages-require-resource-reader-seam.md`.

## 2026-07-26
* **Creation**: added [Desktop spawn-modal race — roster appearance ≠ terminal readiness](/lessons/desktop-spawn-modal-tmux-race.md) from `spawn-modal-tmux-race-diagnosis.md`.
* **Creation**: added [`--relation parent` re-points only the anchor's lineage](/lessons/relation-parent-repoints-only-anchor.md) from `relation-parent-repoints-only-anchor.md`.
* **Creation**: added [Scope a coordinator feature to one developer when ownership scan collapses](/lessons/scope-feature-before-spawning-developers.md) from `single-dev-scoping-split-panels.md`.
* **Creation**: added [Merged-state reviewers catch stale-base drift against moving main](/lessons/stale-base-drift-merged-review.md) from `stale-base-drift-merged-review.md`.
* **Update**: skills/multi-dev-feature — added ownership-scan single-developer scoping from `single-dev-scoping-split-panels.md` and current-origin/main stale-base review guidance from `stale-base-drift-merged-review.md`.

## 2026-07-25
* **Creation**: added [Crossed aweb mail dominates multi-dev integration churn — anchor every mail on exact heads](/lessons/crossed-mail-coordination.md) from dev-coordinator-keybindings note.
* **Creation**: added [Desktop keybindings — editable keymap architecture](/decisions/desktop-keybindings-architecture.md) from dev-coordinator-keybindings note.
* **Creation**: added [Post-merge developer harvests land on instance branches — preserve before retiring](/lessons/post-merge-harvest-stranding.md) from dev-coordinator-keybindings note.
* **Update**: refreshed [Concurrent harvests of one soul: union pure additions, route editorial conflicts](/lessons/concurrent-harvest-conflicts-one-soul.md) with pure-addition union and cross-link verification guidance from dev-coordinator-keybindings note.
* **Update**: refreshed [Integration worktrees need root and package npm installs before gates](/lessons/integration-worktree-desktop-npm-install.md) with root dependency installation before validation gates from dev-coordinator-keybindings note.
* **Update**: skills/multi-dev-feature — added exact-head aweb coordination, post-merge harvest preservation, pure-addition soul-conflict union, and root/package dependency-install guidance from dev-coordinator-keybindings notes.
* **Creation**: added [Integration worktrees need packages/desktop npm install before the gate](/lessons/integration-worktree-desktop-npm-install.md) from dev-coordinator-parallel-2 note.
* **Creation**: added [Merged-state review fixes can overreach scope — validate new user-facing surfaces with the human](/lessons/review-fix-scope-overreach.md) from dev-coordinator-parallel-2 note.
* **Update**: skills/multi-dev-feature — added gotchas for desktop package installs in fresh integration worktrees and human validation before new user-facing surfaces from merged-state review fixes.
* **Creation**: added [Electron linker signatures are not complete ad-hoc app-bundle signatures](/lessons/electron-builder-complete-adhoc-signing.md) from dev-coordinator-1 note.
* **Creation**: added [electron-builder skips macOS signing in pull-request CI unless explicitly enabled](/lessons/electron-builder-pr-signing.md) from dev-coordinator-1 note.
* **Creation**: added [Global capability presence can block repo-scoped lock restoration](/lessons/restore-capabilities-global-shadow.md) from dev-coordinator-1 note.

## 2026-07-24
* **Creation**: added [Desktop succession direction — maintainer positions](/decisions/desktop-succession-maintainer-positions.md) from dev-coordinator-1 note.

## 2026-07-23
* **Creation**: added [Concurrent harvests of one soul need owner reconciliation for knowledge conflicts](/lessons/concurrent-harvest-conflicts-one-soul.md) from dev-coordinator-1 note.
* **Creation**: added [Reviewer deaths can come from tmux prefix-target kills](/lessons/reviewer-deaths-tmux-prefix-targets.md) from dev-coordinator-1 note.
* **Update**: skills/multi-dev-feature — added gotchas for one-soul harvest conflicts and suspected dead reviewer recovery.

## 2026-07-22
* **Creation**: added [Fix doc nits in notes before the harvest runs](/lessons/fix-note-errors-before-harvest.md) from dev-coordinator-1 note.
* **Creation**: added [Retire developers without holding on docs-only follow-up PRs](/lessons/retire-dev-without-docs-pr.md) from dev-coordinator-1 note.
* **Update**: skills/multi-dev-feature — added gotchas for pre-harvest note corrections and docs-only follow-up retirement.

## 2026-07-21
* **Creation**: added [pi session jsonl provider-error shape](/references/pi-session-provider-error-shape.md) from dev-coordinator-1 note.
* **Triage**: dropped dev-coordinator-1 note `integration-branch-discipline.md` because checkout-mode feature/integration discipline is already covered by soul skill `skills/multi-dev-feature`.
* **Initialization**: knowledge bundle scaffolded by oas-okf.

