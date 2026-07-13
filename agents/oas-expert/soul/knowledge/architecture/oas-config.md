---
type: Area Guide
title: oas-config
description: The scoped oas-config.yaml model for capability acquisition declarations, explicit soul groups, target bindings, exclusions, settings precedence, and inherited-layer disables.
tags: [config, workspaces, capabilities, targeting]
timestamp: 2026-07-11
---

`<level>/oas-config.yaml` can exist at laptop, workspace, and repository
levels. Resolution starts in a soul's repository and walks outward. Config
owns deployment policy; packages own reusable artifacts. This guide implements
[capability packages](/decisions/capability-packages.md) and supersedes the
ambient skill/injection model formerly described here.

# Schema

```yaml
name: example
groups:
  developers: [backend, frontend]
capabilities:
  oas.okf:
    source: bundled
    global: true
  vendor.review:
    groups:
      developers:
        enabled: true
        settings: {depth: normal}
    souls:
      backend:
        enabled: true
        settings: {depth: exhaustive}
  vendor.deploy:
    global: true
    groups:
      developers: false
skill-overrides:
  review: vendor.review
agents-md-injection:
  repository: injects/repository.md
work-modes:
  worktree:
    agents-md-injection: default
    setup: scripts/setup-worktree.sh
```

A package declaration without a target is acquired but inactive. Targets are
`global` (all souls governed by that config level), an explicit named group,
or one soul. V1 does not use tags/selectors or instance targets.

For one soul, matching global + groups + soul bindings compose. Settings use
`soul > group > global`, then closer config level. Conflicts at equal
specificity and level error with provenance. Explicit false/exclusion follows
the same precedence.

An active capability declaring `layer: knowledge|messaging|tasks` is the
integration selected for that exclusive fundamental layer. Multiple active
integrations for one layer error. General packages have no layer and are
additive.

# Runtime composition

Spawn resolves by soul name and repository, then materializes kernel + soul +
active capability skills exclusively into the instance's `.agents/skills`.
Duplicate names error unless `skill-overrides` identifies the source. Pi and
Claude consume this same directory; config/ancestor/package skill roots are
not runtime discovery surfaces.

Instance `AGENTS.md` is generated from canonical soul content plus kernel,
actual work mode, active capability, and unconditional config blocks. The
committed soul is never mutated by laptop/workspace/repo capability policy.
`oas doctor --soul <name>` uses the same composer and exposes final text and
provenance.

# Acquisition and trust

External packages are pinned in `<level>/oas-lock.json` by source, exact
version/commit, and integrity. Executable commands/hooks require explicit
trust for the locked integrity; declarative packages still require lock
integrity. Acquisition and activation are separate, and no resolver silently
updates a lock.

# Fundamental-layer disable

`capabilities` is the sole activation map. Because the manifest declares an
integration's layer, config does not repeat provider selection. The only
`layers` form is `layers.<knowledge|messaging|tasks>: none`, which suppresses
an inherited integration at that scope. The unpublished `integrations`,
`providers`, provider-valued `layers`, config hook/skill, and
`.agents/workspace.yaml` shapes have no compatibility promise.
