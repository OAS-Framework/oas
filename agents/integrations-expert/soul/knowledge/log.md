# Knowledge Log

## 2026-07-26
* **Harvest**: promoted [Script-free npm materialization still installs peer dependencies](/lessons/npm-ci-materializes-peer-dependency-closure.md) as a Lesson about npm peer dependency closure materialization during script-free package checks — harvested from integrations-expert-official-packages-staging.
* **Update**: skills/integration-craft — added npm-backed external package materialization guidance for script-free installs, peer/optional dependency inspection, full production audit, advisory escalation, and `node_modules` cleanup.
* **Harvest**: promoted [Crossed coordination messages require state-anchor reconciliation](/lessons/crossed-messages-require-state-anchor-reconciliation.md) as a Lesson about reconciling stale asynchronous branch instructions before repeating destructive work — harvested from integrations-expert-official-packages-staging.
* **Harvest**: promoted [Cross-resource validators must enforce cardinality before invariants](/lessons/manifest-validator-cardinality-must-fail-closed.md) as a Lesson about failing closed on missing or extra capability resources before cross-resource package checks — harvested from integrations-expert-official-packages-staging.
* **Harvest**: promoted [Peer omission must align materialization, audit, and runtime proofs](/lessons/peer-omission-must-align-materialization-audit-and-tests.md) as a Lesson about matching npm peer-omission install, audit, and runtime evidence — harvested from integrations-expert-official-packages-staging.
* **Harvest**: promoted [setup-node npm caching needs an explicit nested lock path](/lessons/setup-node-cache-needs-nested-lock-path.md) as a Lesson about pointing setup-node npm caching at nested package lockfiles — harvested from integrations-expert-official-packages-staging.
* **Update**: skills/integration-craft — added exact-one package validator cardinality, npm peer-omission closure, and nested setup-node cache-path guidance.

## 2026-07-11
* **Update**: [oas-jira settings contract](/decisions/oas-jira-settings-contract.md) now uses canonical capability binding settings and `capabilityMeta` instance metadata.
* **Harvest**: promoted [Capability artifact paths must stay inside the integrity boundary](/lessons/capability-artifact-paths-must-be-integrity-bounded.md) as a Lesson about keeping locked external capability paths within the hashed artifact — harvested from integrations-expert-capability-packages-review.
* **Update**: skills/integration-craft — added external-package manifest path integrity-boundary guidance and escape-path verification coverage.

## 2026-07-10
* **Harvest**: promoted [Tracker integration docs need an explicit support matrix](/lessons/tracker-integration-docs-support-matrix.md) as a Lesson about documenting task-tracker project/document support boundaries — harvested from integrations-expert-linear-tasks.
* **Update**: skills/tasks-integration — added project/document support matrix guidance, durable-information placement, and unsupported-operation escalation checks.
* **Fix**: created empty section indexes for root-listed knowledge sections so the bundle validates in strict mode.
* **Harvest**: promoted [Prefer an integration-owned Linear GraphQL wrapper](/decisions/linear-task-interface-selection.md) as a Decision about the task-layer command surface for Linear integrations — harvested from integrations-expert-linear-tasks.
* **Harvest**: promoted [oas-jira settings contract](/decisions/oas-jira-settings-contract.md) as a Decision (needs human review of the invented settings shape); merged note "integration probe testing" into skills/integration-craft (Probe recipe & gotchas under Testing) — harvested from integrations-expert-jira-integration.
* **Update**: skills/integration-craft — added spawnInstance probe recipe, agent-object gotcha, missing-requires and negative-scoping test commands.
* **Update**: skills/tasks-integration — merged note "Tasks-layer neutrality" (human correction): tracker choice is a deployment decision, not a framework rule; Jira-over-aweb is LFX's rationale, aweb-tasks is a legitimate separate integration; rule 5's boundary reworded framework-neutral (harvested from integrations-expert-jira-integration).

## 2026-07-09
* **Creation**: soul created by oas-expert (founding session) — role: build custom integrations with users; skills: integration-craft + tasks/messaging/knowledge-integration.
* **Initialization**: knowledge bundle scaffolded by oas.
