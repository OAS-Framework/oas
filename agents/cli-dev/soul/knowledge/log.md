# Knowledge Log

## 2026-07-24

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
