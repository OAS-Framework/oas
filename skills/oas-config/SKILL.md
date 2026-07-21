---
name: oas-config
description: >-
  How to configure OAS deployments with oas-config.yaml and the oas CLI.
  Use for capability acquisition/activation/trust, fundamental-layer
  integrations, agent types, targeting souls, binding settings, injection
  overrides, or config scopes. Triggers: "install a capability", "bind a
  layer", "target these souls", "agent type", "override an injection",
  "oas use", "oas init", "configure OAS", "oas-config.yaml".
---

# Configuring OAS

Config lives in `oas-config.yaml` at laptop (`~`), workspace, and repository
levels; resolution walks from a soul's repository outward, closest scope wins.
Prefer the CLI for config edits (`oas init`, `oas use`, `oas type`,
`oas inject eject`, `oas create --type`); hand-editing is valid but the CLI
writes the canonical shape.

## Shape

```yaml
team:                          # deployment boundary (typically workspace scope)
  name: lfx-engineering
  # id: lfx-engineering:example.com   # provider team id (aweb <name>:<namespace>)
agent-types:
  developers:
    description: Agents that build the service
capabilities:
  layers:                      # exclusive fundamental slots
    knowledge:
      capability: oas.okf
      from: installed            # enforced provenance: installed|owned|path:<dir>
      # injection-override: .agents/injections/capabilities/oas.okf.md
    messaging: none            # explicit none suppresses inherited integrations
    tasks: none
  additive:                    # non-exclusive packages
    vendor.review:
      from: installed
      agent-types:
        developers:
          enabled: true
          settings: {depth: normal}
      souls:
        api-expert:
          enabled: true
          settings: {depth: exhaustive}
```

`global` means every soul governed by the declaring level. Bindings can also
target **agent types** (families — declared in config via `oas type add`,
joined via `type: <name>` in each soul.yaml) and individual souls. Matching
global + agent-type + soul bindings compose. Settings precedence is
soul > agent-type > global, then closer config. Equal-specificity conflicts
error. `false`/`enabled: false` is an explicit exclusion and follows the same
precedence. V1 does not target instances or use tags/selectors.

The closest `team:` declaration marks the deployment boundary: all repos
under it share one team (identity + `oas status --team` discovery + the
messaging provider's team). Declare it once at the workspace scope. With
aweb messaging active, `oas aweb setup` walks the onboarding (aw CLI →
workspace init → team create/join) and `oas aweb roster` shows the
cross-machine member directory.

```bash
oas type add <name> [--description <d>] [--dir <level>]
oas type list
```

## Injection overrides

Capability entries and the `oas:` kernel block take an
`injection-override: <path>|none|default`. Work-mode briefings are packaged
and NOT overridable; the only work-mode key is `setup:` (env bootstrap run in
each new worktree). The clean path is ejecting:

```bash
oas inject eject <capability-id|oas> [--dir <level>]
```

It copies the packaged default to the conventional
`.agents/injections/{capabilities/<id>.md, oas-defaults/oas.md}` path and
sets the override — the file then stops
tracking package updates, deliberately. Overrides are **not allowed** on
`from: owned`/`path:` capabilities: the scope owns the package source, so
edit `.agents/capabilities/owned/<id>/injects/` directly.

## Acquire, trust, activate

These are separate steps:

```bash
oas install [<git-url|path>] [--dir <level>]  # acquire + exact lock into the scope's
                                              # .agents/capabilities/installed/; bare form
                                              # restores locked-but-missing artifacts; inactive
oas trust <capability> [--dir <level>]        # approve locked commands/hooks
oas use <capability> --global [--dir <level>]
oas use <capability> --type <agent-type> [--disable]
oas use <capability> --soul <name> [--settings k=v [k2=v2 ...]]
```

External `oas-lock.json` entries pin source, exact version/commit, and
integrity. OAS never silently pulls. Executable approval is tied to integrity;
changed artifacts block. Skill/instruction-only packages still need a lock but
not executable approval.

`oas init` creates config and activates only explicit defaults. Acquired or
marketplace availability does not imply acquisition or activation.

## Fundamental layers

Knowledge, messaging, and tasks are formal exclusive contracts. A package
manifest declaring one `layer` is an integration. Two active integrations for
the same layer error; a closer scope's entry (or `none`) overrides outer ones.

| Layer | Bundled | Requirement |
|---|---|---|
| knowledge | `oas.okf` | none |
| messaging | `oas.aweb` | `aw` CLI |
| tasks | none by default; `oas.jira` or `oas.linear` available | provider-specific |

Activation uses the manifest-declared layer — `oas use` writes the entry
under `capabilities.layers.<layer>` automatically:

```bash
oas use <capability> --global|--type <agent-type>|--soul <name>
oas use none --layer <layer>
```

`capabilities` is the only activation map: fundamental integrations under
`capabilities.layers.<layer>` (entry or explicit `none`), everything else
under `capabilities.additive`.

Rare hand-edited keys: `skill-overrides:` (names the winning source on
duplicate skill names), the top-level `agents-md-injection:` map (extra
unconditional instruction blocks), `templates:` (named init seeds).

## Verify

```bash
oas doctor [context] [--soul <name>] [--json]
```

Doctor shows config chain, acquired/active packages, layer selection, target
and settings provenance, requirements, trust, skill sources, instruction
blocks, and — with `--soul` — the final composed AGENTS.md.
