---
name: oas
description: >-
  How to operate inside OAS (Open Agent Specialization) and configure it with
  the universal oas CLI. Use for instance layout/lifecycle, status, spawn,
  retire, doctor, init, capability acquisition/activation/trust, soul groups,
  fundamental-layer integrations, or explaining OAS. Triggers: "spawn an
  agent", "what agents are running", "retire this instance", "oas doctor",
  "install a capability", "bind a layer", "target these souls", "how does
  OAS work".
---

# Operating in OAS

A **soul** is a durable specialized agent. An **instance** is one disposable,
resumable incarnation. A **capability package** distributes reusable skills,
instructions, commands, and approved lifecycle hooks. An **integration** is a
capability selected for one exclusive knowledge, messaging, or tasks layer.

## Instance home

| Path | Meaning |
|---|---|
| `TASK.md` | briefing and task |
| `soul/` | linked canonical soul |
| `AGENTS.md` | generated canonical soul + active capability instructions |
| `CLAUDE.md -> AGENTS.md` | compatibility view |
| `.agents/skills/` | exact runtime skill set |
| `work/` | all repository work happens here |
| `instance.json` | repo, branch, capabilities, skills, instruction sources, trust, hooks |

Memory files exist only when the selected knowledge integration creates them.
Follow their injected protocol.

## Lifecycle and roster

```bash
oas status [--json]
oas create <name> [--description ...] [--repo ...] [--work worktree|checkout]
oas spawn <agent> [--task ...] [--purpose ...] [--no-launch] [--json]
oas retire <instance> [--delete-branch]
```

Do not spawn on your own judgment. Spawn when the human asks or a documented
workflow requires it.

To self-retire, first finish memory/commit/reporting requirements, report final
status, then run `oas retire <own-instance> --self`. Never retire merely to
clean up; retirement deletes the instance home.

## Canonical versus generated

Edit `soul/AGENTS.md` for durable role instructions. Instance `AGENTS.md` is a
generated view; marked blocks name their source. Config changes do not mutate
the committed soul. Preview a fresh composition with:

```bash
oas doctor /path/to/context --soul <name>
```

Both pi and Claude receive only the OAS-composed instance
`.agents/skills/`. Duplicate names fail unless `skill-overrides` explicitly
chooses a source. Exact pi isolation requires matching capability-aware
versions of `@oas-framework/oas` and `@oas-framework/pi`. Upgrade both together.

## Configuration scopes and targets

Config lives in `oas-config.yaml` at laptop, workspace, and repository levels.
`global` means every soul governed by the declaring level. V1 also supports
explicit config-owned groups and individual souls:

```yaml
groups:
  developers: [api-expert, ui-expert]
capabilities:
  oas.okf:
    global: true
  vendor.review:
    groups:
      developers:
        enabled: true
        settings: {depth: normal}
    souls:
      api-expert:
        enabled: true
        settings: {depth: exhaustive}
```

Matching global + groups + soul bindings compose. Settings precedence is soul
> group > global, then closer config. Equal-specificity conflicts error.
`false`/`enabled: false` is an explicit exclusion and follows the same
precedence. V1 does not target instances or use tags/selectors.

## Acquire, trust, activate

These are separate steps:

```bash
oas install [<git-url|path>] [--dir <level>]  # acquire + exact lock into the scope's
                                              # .agents/capabilities/installed/; bare form
                                              # restores locked-but-missing artifacts; inactive
oas trust <capability> [--dir <level>]                # approve locked commands/hooks
oas use <capability> --global [--dir <level>]
oas use <capability> --group <name> [--disable]
oas use <capability> --soul <name>
```

External `oas-lock.json` entries pin source, exact version/commit, and
integrity. OAS never silently pulls. Executable approval is tied to integrity;
changed artifacts block. Skill/instruction-only packages still need a lock but
not executable approval.

`oas init` creates config and activates only explicit defaults. Acquired or
bundled availability does not imply activation.

## Fundamental layers

Knowledge, messaging, and tasks remain formal exclusive contracts. A package
manifest declaring one `layer` is an integration. Two active integrations for
the same layer error.

Bundled defaults/choices:

| Layer | Package | Requirement |
|---|---|---|
| knowledge | `oas.okf` | none |
| messaging | `oas.aweb` | `aw` CLI |
| tasks | none by default; `oas.jira` or `oas.linear` available | provider-specific |

Activation uses the manifest-declared layer:

```bash
oas use <capability> --global|--group <name>|--soul <name>
oas use none --layer <layer>
```

`capabilities` is the only activation map. `layers.<layer>: none` is reserved
for suppressing an inherited integration.

## Commands and doctor

Operational namespaces run only when their package is active in the current
context/instance:

```bash
oas okf harvest
oas linear issue list ...
```

Package-management commands remain global. Use doctor first when something is
missing:

```bash
oas doctor [context] [--soul <name>] [--json]
```

It shows config chain, acquired/active packages, layer selection, target and
settings provenance, requirements, trust, skill sources, instruction blocks,
and—with `--soul`—final composed text.

Infrastructure faults should be reported to the spawner/human, not repaired by
an instance ad hoc.
