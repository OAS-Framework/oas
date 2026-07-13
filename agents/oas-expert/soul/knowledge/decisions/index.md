# Decisions

* [Scoped capability store, restorable installs, and config templates](scoped-capability-store-and-templates.md) - All capabilities live in the owning scope's .agents/capabilities/ (installed/ vs owned/); bare `oas install` restores from the lock; `oas init --template` seeds configs from local or git templates.
* [Control Pane v3 card architecture](control-pane-v3-card-architecture.md) - The Control Pane v3 redesign replaces the list+inspector split with a single identity-rail card stack, in-place expansion, variable-height scrolling, and full-screen zoom.
* [Control Pane is a live standalone TUI](control-pane-live-standalone-tui.md) - OAS exposes its current agent constellation through `oas pane`, with a runtime-neutral data model and no historical reconstruction.
* [Control Pane visual language](control-pane-visual-language.md) - Design decisions from the Control Pane redesign: soul badges, branch chips, tree glyphs, three-line rows, and the feedback that drove them.
* [Capability packages and instance-local composition](capability-packages.md) - OAS distributes reusable agent capabilities as targetable packages while retaining formally defined, exclusive knowledge, messaging, and tasks layers.
* [Standalone oas CLI](standalone-cli.md) - One npm package (@oas-framework/oas), runtime-neutral lib/core.mjs; CLI is the single integration point for all runtimes; oas install for integrations.
* [One tasks layer owns tasks](jira-over-aweb-tasks.md) - Whichever integration the user binds (Jira, aweb tasks, any tracker) is the single task/roster layer; task features of other tools stay off.
* [Deployment config over package forks (evolved)](workspace-configs-over-subpackages.md) - Deployment targeting and settings belong in scoped oas-config.yaml; reusable behavior belongs in capability packages rather than deployment-specific forks.
* [Workspace-seeded knowledge sections (superseded)](workspace-seeded-knowledge-sections.md) - The pre-contract workspace.yaml knowledge-sections mechanism was removed; knowledge-package settings now own any custom seed behavior.
* [Kernel and providers](kernel-and-providers.md) - OAS splits into a kernel plus provider packages (oas-okf, oas-aweb) for the pluggable layers — knowledge format, messaging, tasks.
* [Instances symlink the soul rather than copy it](soul-knowledge-symlink-rationale.md) - Instance homes link ./soul to the shared soul directory so all instances see one source of truth and harvest write-back propagates immediately.
