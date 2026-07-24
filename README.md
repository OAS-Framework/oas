# OAS — Open Agent Specialization

**Agents should grow into experts, not restart as generalists every time.**

Most agent setups give a repo one assistant. One `AGENTS.md`, one skill set,
one memory story. Harnesses like Claude Code add subagents and workflows on
top, but those are second-class. Subagents are throwaway calls inside someone
else's session, with poor steering and no way to learn. Claude Code's
workflows, although powerful, cannot be steered at all while they run.

OAS treats agents as **specialized experts**, and every one is a first-class
citizen. The UI agent, backend expert, maintainer, and review agent each get
their own setup, their own memory, and their own full session that you can
walk into and steer.

## The problems OAS solves

**Agents forget.** Every new session starts from zero. OAS gives each expert
a durable **soul** that accumulates knowledge and skills. Instances capture
what they learn, and a harvest process promotes the durable lessons back into
the soul. The tenth incarnation of your backend expert knows things the first
one had to figure out.

**Subagents are second-class.** In most harnesses, a subagent is a hidden
tool call. In OAS, every spawned agent is a full pi or Claude Code session in
its own tmux window. You can attach to any of them and steer. And every
instantiation is an instantiation of a soul, so everything it learns
nourishes that soul.

**Workflows are rigid.** OAS agents are all peers that launch through tmux
and can talk to each other, so workflows can be as simple or as complex as
the work needs. A task can span several repos, each with a coordinator soul
instantiated to run the cross-repo work and that repo's own developers. Those
developers might be a backend and a frontend expert, and the backend expert
can launch helper instances of itself for parallel work. A shape that works
well in practice: one coordinator, two developers, a reviewer or two on a
different model, and a maintainer gating main on yet another model.

**One size never fits all teams.** Knowledge, messaging, and task tracking
are pluggable layers. One workspace runs OKF, aweb, and Jira. Another runs a
team wiki, Slack, and GitHub Issues. A solitary repo turns messaging off.
Only the layer binding changes, never what a soul is.

## Souls, instances, sessions

A **soul** is the durable expert. It is committed and reviewed like code:

- `soul.yaml` — name, target repo, work mode, runtime, and default model.
- `AGENTS.md` — the canonical operating doc (`CLAUDE.md` is a compatibility
  view).
- `skills/` — procedures this expert knows how to run.
- `knowledge/` — long-term memory, if a knowledge integration provides one.

The soul is model-agnostic as an artifact. Its default model is only a
default, and an instance can be spawned or resumed on a different model.

When work starts, the soul is instantiated as an **instance**. An instance is
a named incarnation with its own ID, home, worktree (if needed), briefing, and
lifecycle. Starting a session inside that instance brings it to life. The
session is a full coding-agent session with its own tools and home, not a
lightweight subagent call. One instance can hold several sessions across
restarts, compactions, and model switches until it is retired.

> *A vampire analogy helps:*
>
> - *Pepe's soul is what makes all Pepes Pepe.*
> - *An instance gives Pepe's soul a unique body — call it Pepe 1 — that can
>   come to life.*
> - *A session brings Pepe 1, body and soul, into the world.*
> - *Pepe 1 lives, interacts with the world, works, and learns. What he learns
>   nourishes the soul.*
> - *Maybe Pepe 1 even dies and resuscitates a couple times: the session stops,
>   then another session starts in the same instance.*
> - *Finally, Pepe 1's body is cremated. He is a vampire, so that body can
>   never come back to life — the instance has been retired.*
> - *But it is fine. Future incarnations of Pepe benefit from Pepe 1's
>   experience. Pepe's soul can reincarnate in another body, and new Pepes
>   carry the useful learnings and teachings forward.*

Souls compound. Instances do the work. A soul can have as many instances as
people need. Instances are runtime state and normally gitignored, so expert
souls can travel with a repo while different teams instantiate them into
their own local agent teams without colliding.

```text
agents/docs-expert/soul/              # the durable expert
agents/docs-expert/instances/audit/   # one disposable incarnation
```

OAS experts also work as a team. One agent can spawn another, and the
recommended messaging layer is [aweb.ai](https://aweb.ai): it gives each
instance an identity so agents can coordinate with each other and with you.
A task layer can bind the team to Jira, Linear, GitHub Issues, or anything
else.

The kernel artifacts are plain files: markdown, YAML, and symlinks. Any
harness can read them.

Read [Souls and instances](docs/souls-and-instances.md) for the full anatomy
and lifecycle.

## The five layers

OAS is built around five layers. The kernel owns the layers that make an
agent a soul and its instances. The other layers are contracts that integrations
bind to real tools.

| #   | Layer         | What it provides                                                                                                                                                                          | Solved by                       |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | **Soul**      | Durable expert identity: `AGENTS.md`, soul skills, long-term knowledge                                                                                                                    | OAS kernel                      |
| 2   | **Knowledge** | Where learning lives, how it is captured, and how it gets promoted — the format is pluggable, but we believe some ideas hold regardless: see [knowledge theory](docs/knowledge-theory.md) | Integration, default `oas-okf`  |
| 3   | **Instances** | Where a soul is instantiated, gets a unique ID and home, and interacts with the world                                                                                                     | OAS kernel                      |
| 4   | **Messaging** | Reachable identities so agents and humans can talk                                                                                                                                        | Integration, default `oas-aweb` |
| 5   | **Tasks**     | Work queues and status that outlive any one instance                                                                                                                                      | Integration, no shipped default |

This split is what makes OAS flexible. Knowledge, messaging, and tasks remain
formally defined, exclusive slots. Each is solved by an
[**integration**](docs/integrations.md): the capability package selected for
that layer. General [capability packages](docs/capabilities.md) are additive
and can teach any reusable workflow.

See [The five layers](docs/layers.md) for the full model.

### Work modes

A work mode decides what an instance's `./work` points at and what discipline
the agent must follow. It is part of a soul's identity.

- **`worktree`** — `work/` is a git worktree on the instance's own branch.
  Use it for agents that edit code or docs independently. Several developer
  instances can work in parallel without stepping on each other.
- **`checkout`** — `work/` is a symlink to the repo checkout itself, on the
  currently checked-out branch. Use it for coordinators, maintainers, and
  auditors that work on the repo's current state.
- **`attached`** — a spawn-time mode for service agents that operate inside
  another instance's tree, such as the memory harvester.

### Retirement

An instance ends when it is retired. Retirement runs active capability retire
hooks (for example, aweb deletes the instance's messaging identity), removes
the instance home, and **removes the instance's worktree** if it had one.
An agent can retire itself with `oas retire <instance> --self` when its
briefing says it is done. Retirement is irreversible for that body, but the
soul carries the learnings forward.

## The knowledge lifecycle

With the default `oas-okf` integration, learning flows in a loop.

1. **Spawn.** The instance gets episodic memory files: `STATE.md` (live
   working state), `log.md` (dated milestones), and `notes/` (captured
   insights).
2. **Work.** As the instance works, it keeps `STATE.md` current and writes
   non-obvious insights into `notes/` as small OKF concepts. A fresh session
   can resume the instance from these files alone.
3. **Harvest.** After committing with pending notes, the instance runs
   `oas okf harvest` (its briefing says so). A memory-harvest agent spawns
   attached to the same work tree. It promotes durable lessons into the
   soul's knowledge bundle or soul skills, merges or drops the rest,
   commits, and retires itself.
4. **Compound.** The next instance of that soul starts with everything past
   incarnations learned.

Harvest happens continuously after commits, so long-lived instances feed
their souls while still alive. Retirement is a knowledge no-op.

The harvester itself is an agent like any other: oas-okf ships its soul
definition and materializes it on first harvest as a **local (gitignored)
soul** under `agents/local-agents/memory-harvest/` — integration
infrastructure, not a roster member. It is also fully replaceable: craft
your own harvester soul and override the okf `injection` in your
config to point instances at it. The loop is a convention, not a mechanism
you are locked into. See [Knowledge](docs/knowledge.md) and
[knowledge theory](docs/knowledge-theory.md).

## Workspaces: where configuration lives

An **OAS workspace** is any scope where agents share configuration. It can be
your laptop, a folder of related repos, or a single repo. The workspace root
is where you put `oas-config.yaml`.

```text
~/oas-config.yaml                         # laptop-wide OAS workspace
~/acme/oas-config.yaml                    # multi-repo OAS workspace
~/acme/project-service/oas-config.yaml    # repo OAS workspace
```

The rule for placing a setting is simple. **Put it at the level where every
agent below should feel it.** In multi-repo work, a decision that affects all
agents across the repos — the task tracker, the messaging setup, shared
conventions — goes in the config at the root folder that contains them. A
decision only one repo cares about goes in that repo's config.

The config answers which packages are acquired and which souls receive them.
Bindings can target all souls governed by that config level, an explicit soul
group, or one soul. Matching global, group, and soul bindings compose;
settings use soul > group > global specificity, and explicit exclusions are
supported.

Each spawned instance then receives an exact, auditable view: soul skills plus
active capability skills in its own `.agents/skills/`, and a generated
`AGENTS.md` built from the canonical soul plus selected instruction blocks.
Laptop/workspace/repo config never mutates the committed soul.

`oas doctor --soul <name>` shows target provenance, selected fundamental
layers, trust, skills, and final composed instructions. See the
[worked configuration examples](docs/configuration.md#worked-examples).

## Instance-local instructions and skills

The committed soul stays portable: its `AGENTS.md` contains only canonical
role instructions and its `skills/` contains soul-private procedures. At
spawn, OAS resolves active capabilities and creates an instance-local view:

1. generated `AGENTS.md` = canonical soul + kernel + work mode + capability +
   config instruction blocks;
2. exact `.agents/skills/` = kernel + soul + selected capability skills; and
3. `instance.json` records every source and setting.

Both pi and Claude use that same directory. Pi starts with ambient skill
discovery disabled; Claude receives an instance-local config home. Duplicate
skill names fail unless config explicitly selects an override. This gives one
soul different deployment capabilities without changing its committed files.

See [Capability packages](docs/capabilities.md#exact-runtime-composition).

## Capability packages distribute reusable behavior

A capability package can ship skills, optional instance instructions,
requirements, namespaced commands, and `soul-scaffold`/`spawn`/`retire` hooks.
Packages never choose their targets; `oas-config.yaml` owns global, group, and
soul bindings.

Acquisition is separate from activation. External packages are pinned by
source, exact version/commit, and integrity in `oas-lock.json`; executable
commands and hooks require explicit trust for that exact artifact. An
integration is simply a capability that declares one fundamental layer, so
knowledge/messaging/tasks stay exclusive while general capabilities compose.

See [Capability packages](docs/capabilities.md) and
[Integrations](docs/integrations.md).

## What ships

The reference implementation ships as two npm packages from this repo:

**`@oas-framework/oas`** — the kernel and the universal `oas` CLI:

- `lib/core.mjs` — the runtime-neutral kernel.
- `bin/oas.mjs` — the CLI: agent operations (`status`, `create`, `spawn`,
  `retire`), config (`doctor`,
  `init`, `use`, `install`, `root`), and active capability commands
  (`oas okf harvest`). The same commands work from pi, Claude Code, or a plain
  shell.
- `skills/` — kernel/bootstrap skills.
- `capabilities/oas-okf/` — the default knowledge integration package.
- `capabilities/oas-aweb/` — the default messaging integration package.
- `capabilities/oas-jira/` and `oas-linear/` — task integration packages.
- `capabilities/oas-authoring/` — additive framework-authoring skills.
- `injects/` — kernel and work-mode instruction sources.

**`@oas-framework/pi`** — a thin pi adapter: instance-local skill exposure and
memory session events. It registers no tools — all operations go through the
CLI. Claude instances consume the same generated files without a plugin.

Use `oas init` for default OKF + aweb config, or `oas init --raw` for all
layers set to `none`.

Status as of 2026-07-13: capability acquisition/activation, agent types
declared in souls with config targets, exact pi/Claude instance composition, generated
instructions, layer exclusivity, lock/integrity/trust, namespaced command
gating, deterministic hooks, scaffold ownership, the config cascade, all
three work modes, the first clean capability-package contract, and the live
Control Pane are implemented.

See [Implementation](docs/implementation.md) for details.

## Installation

The `oas` CLI installs globally from npm; the pi adapter adds skill
discovery and instance memory automation on top of it:

```bash
npm install -g @oas-framework/oas       # the kernel + oas CLI (required)
pi install npm:@oas-framework/pi        # pi adapter (skills + memory automation)
```

Install matching versions of both packages, then reload pi. Exact pi skill
isolation depends on both parts. The kernel launches pi with ambient discovery
disabled, while the adapter stops contributing workspace and package skill
roots. The release workflow publishes both packages from the same version tag.
Upgrade them together when adopting this capability model.

`oas` remains the single source of truth. The pi adapter and any future Claude
plugin are thin layers over it.

## Getting started

Once installed, the fastest path is to let an agent walk you through setup:
**ask any pi agent to load its `oas-getting-started` skill** and set up OAS
for your workspace. That skill is available globally the moment the adapter is
installed — it covers choosing the knowledge/messaging/tasks layers (and their
defaults), creating your first `oas-config.yaml`, and creating and spawning
your first agent.

> Load your `oas-getting-started` skill and help me set up OAS in this repo.

If you would rather drive the CLI yourself:

```bash
oas doctor        # resolved config from anywhere (empty until you create one)
oas init          # default setup; also offers normal mouse/trackpad tmux scrolling
oas init --raw    # no integrations; wire your own with `oas use`
```

Or onboard through the framework's own expert: clone this repo, `pi install
.`, then ask an agent to spawn the `oas-expert` soul (at `agents/oas-expert/`)
— it knows the framework, the config model, and the setup path, and can guide
your first config and agents.

## Learn more

- [The five layers](docs/layers.md) — the specialization model.
- [Souls and instances](docs/souls-and-instances.md) — durable experts and disposable runs.
- [Knowledge](docs/knowledge.md) — capture, harvest, and promotion.
- [Knowledge theory](docs/knowledge-theory.md) — what belongs in a soul vs an instance, whatever the format.
- [Configuration](docs/configuration.md) — scopes, agent types, targeting, exclusions, and examples.
- [Capability packages](docs/capabilities.md) — distribution, manifests, composition, locks, and trust.
- [Integrations](docs/integrations.md) — capability packages that satisfy fundamental layers.
- [Conventions](docs/conventions.md) — canonical files, symlinks, and skill paths.

## Origins

OAS grew out of the a2am team architecture and the LFX engineering vision for
agent-native engineering. It builds on open standards: agents.md for operating
docs, Agent Skills for procedures, and OKF for the default knowledge bundle.
