# Knowledge Log

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
