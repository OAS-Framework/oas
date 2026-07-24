# Knowledge Log

## 2026-07-24
* **Creation**: [hasownproperty-vs-truthiness](/lessons/hasownproperty-vs-truthiness.md) records that manifest command lookup must distinguish absent keys from declared-but-falsy values before assigning error codes.
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
