---
type: Decision
title: Capability behavior uses declarative resources, lifecycle hooks, commands, and launch contributions
description: The kernel stays package-neutral by exposing four explicit capability seams instead of special-casing integrations or treating every extension as a command override.
tags: [capabilities, hooks, commands, runtime, architecture]
timestamp: 2026-07-27
---

# Decision

Capability behavior composes through four distinct generic seams:

1. **Declarative instance resources** — skills, optional instruction injections, capability-defined agents, and selected runtime plugins/extensions. Spawn resolves these only from capabilities active for the target soul, materializes or composes them into the instance home, and records provenance.
2. **Lifecycle hooks** — structured callbacks at approved lifecycle events such as soul `create`, instance `spawn`, and `retire`, with explicit required-versus-best-effort semantics. OKF soul knowledge scaffolding is a create hook; OKF instance state/log/notes scaffolding and aweb identity/workspace setup are spawn hooks; aweb cleanup is a retire hook.
3. **Capability commands** — namespaced agent-callable CLI dispatch such as `oas okf harvest` or `oas aweb ...`, executed through the canonical structured OAS CLI boundary. These are declared commands, not vague command overrides.
4. **Runtime launch contributions** — selected provider plugins/extensions and structured launch metadata. The aweb Claude channel or Pi extension is an explicit runtime resource; its spawn hook may prepare identity/config and contribute structured launch metadata, but the plugin is not a transport for OAS skills.

The kernel resolves active capabilities, validates and trusts their declarations, executes the relevant generic seams, and records outcomes/provenance. It must not acquire package-specific branches such as `if capability == oas.okf` or `if capability == oas.aweb`.
