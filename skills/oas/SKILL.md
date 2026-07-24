---
name: oas
description: >-
  How to operate inside OAS (Open Agent Specialization): instance layout and
  lifecycle, status, spawn, retire, doctor, operational capability commands,
  canonical-vs-generated instructions, or explaining OAS. For configuring
  deployments (capabilities, layers, agent types, injections) load the
  oas-config skill. Triggers: "spawn an agent", "what agents are running",
  "retire this instance", "oas doctor", "oas status", "how does OAS work".
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
oas status --team [--json]   # whole-team roster when config declares team: (all repos in the team scope)
# with the aweb messaging integration active, `oas aweb roster` adds the
# cross-machine view: aweb team members, where OAS aliases are instance names
oas create <name> [--description ...] [--type <agent-type>] [--repo ...] [--work worktree|checkout|attached|workspace]
# workspace mode = cross-repo coordinator: ./work is the whole team scope; read
# all member repos, edit none; soul knowledge updates arrive as PRs to the
# soul's home repo via `oas okf harvest`
oas spawn <agent> [--task ...] [--purpose ...] [--parent <instance>] [--no-launch] [--json]
# lineage is explicit: agents spawning sub-agents MUST pass --parent "$OAS_INSTANCE"
# (or their own instance name); without --parent the spawn is operator-origin and
# appears top-level. Attached-mode spawns nest under the work-tree owner automatically.
# when config declares team:, spawn/retire also resolve souls and instances
# defined in sibling repos of the team scope (unique match wins; the instance
# homes with its owning repo, works in that repo, resolves that repo's config)
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

The instance's `.agents/skills/` holds the exact OAS-composed set (kernel +
soul + active capabilities); `.claude/skills` mirrors it. Harness-ambient
skills (user-level, packages, work tree) coexist with this set. Duplicate
names *within* the OAS set fail spawn unless `skill-overrides` explicitly
chooses a source.

## Configuration

Deployments are configured in scoped `oas-config.yaml` files (laptop /
workspace / repository) declaring capability packages, exclusive
knowledge/messaging/tasks layers, agent types, targeting, and injection
overrides. The CLI is the config author (`oas init`, `oas use`, `oas type`,
`oas inject eject`). **Load the `oas-config` skill for all configuration
work** — this skill covers operating, not configuring.

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
