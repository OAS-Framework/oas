---
type: Area Guide
title: oas-config
description: The scoped oas-config.yaml model — agent-types with soul-declared membership, capabilities split into exclusive layer slots and additive packages, from provenance, injection overrides, and CLI-authored config.
tags: [config, workspaces, capabilities, targeting, agent-types]
timestamp: 2026-07-13
---

`<level>/oas-config.yaml` can exist at laptop, workspace, and repository
levels. Resolution starts in a soul's repository and walks outward. Config
owns deployment policy; packages own reusable artifacts. This guide implements
[capability packages](/decisions/capability-packages.md) as amended by
[config shape v2](/decisions/config-shape-agent-types-and-injections.md); the
CLI (`oas init` / `oas use` / `oas create --type`) is the primary config
author.

# Schema

```yaml
name: example
agent-types:
  developers:
    description: Agents that build the service
capabilities:
  layers:                       # the three exclusive fundamental slots
    knowledge:
      capability: oas.okf
      from: bundled             # enforced provenance: bundled|installed|owned|path:<dir>
      # injection-override: .agents/injections/capabilities/oas.okf.md
    messaging: none             # explicit none suppresses inherited integrations
    tasks: none
  additive:                     # non-exclusive packages
    vendor.review:
      from: installed
      agent-types:
        developers:
          enabled: true
          settings: {depth: normal}
      souls:
        backend:
          enabled: true
          settings: {depth: exhaustive}
skill-overrides:
  review: vendor.review
agents-md-injection:            # extra unconditional blocks (adds, not overrides)
  repository: injects/repository.md
work-modes:
  worktree:
    # injection-override: .agents/injections/workmodes/worktree.md
    setup: scripts/setup-worktree.sh
oas:
  # injection-override: .agents/injections/oas-defaults/oas.md
```

Agent types are families: config declares names (+ descriptions); each soul
opts in via a single optional `type: <name>` in its soul.yaml. Membership is
soul identity, not config policy. Targets are `global` (all souls governed by
that config level), an agent type, or one soul; specificity is
soul > type > global, then closer config level. Conflicts at equal
specificity and level error with provenance. Explicit false/exclusion follows
the same precedence.

A layer entry's capability manifest must declare that layer; a
layer-declaring capability under `additive` errors. A layer entry with no
explicit targets is globally enabled at its scope. An additive declaration
without targets is acquired but inactive. `capabilities.layers.<layer>: none`
suppresses an inherited integration; an absent slot inherits.

`from:` is doctor-enforced provenance documentation: the discovered artifact
origin (bundled / installed+locked / owned / path) must match.

Every injectable item (capability entry, work mode, `oas:` kernel block)
takes `injection-override: <path>|none|default`; scaffolded configs carry
commented lines pointing at the
`.agents/injections/{capabilities,workmodes,oas-defaults}/` conventions, and
`oas inject eject` materializes one (copy packaged default + set the key).
Overrides are rejected on `from: owned`/`path:` entries — the scope owns the
package source and edits its `injects/` file directly (see the
[authorship decision](/decisions/config-authorship-and-ambient-skills.md)).

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

# Removed spellings

The v0.8 shapes — `groups:` with soul lists, top-level `layers:`, flat
`capabilities.<id>` maps, `source:`/`path:` capability keys, and
`agents-md-injection` as a per-item override — are rejected with pointed
migration errors, per the clean-contract precedent. The free-form top-level
`agents-md-injection:` map (additional blocks) remains. `oas use` re-serializes
the `capabilities:` block; custom comments inside it are not preserved.
