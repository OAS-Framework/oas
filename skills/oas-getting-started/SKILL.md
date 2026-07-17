---
name: oas-getting-started
description: >-
  How to set up OAS (Open Agent Specialization) in a workspace from scratch —
  install the CLI/pi adapter, choose fundamental-layer integrations and shared
  capabilities, create oas-config.yaml, and create/spawn the first specialized
  agent. Use for "get started with OAS", "set up/install/adopt OAS", "create
  my first agent", or "how do I start using OAS".
---

# Getting started with OAS

OAS gives a workspace durable specialized **souls**, disposable **instances**,
and targetable **capability packages**. Do not run setup blindly: present each
default and ask the user before writing config or spawning agents.

## 1. Install

```bash
npm install -g @oas-framework/oas
pi install npm:@oas-framework/pi
```

The CLI/kernel is runtime-neutral. The pi adapter supplies only minimal runtime
glue. Install matching versions and upgrade both packages together. Exact pi
isolation needs the kernel's launch flags and the changed adapter's
instance-only discovery. Reload pi after installing or upgrading the adapter.

This skill is the one pre-workspace ambient bootstrap. Spawned instances
receive exact local skills.

## 2. Choose scope

`oas-config.yaml` can live at:

- laptop (`~/oas-config.yaml`): defaults for governed workspaces;
- workspace: shared multi-repo policy; or
- repository: repo-specific policy.

Ask which scope the user intends. `oas init` detects home as laptop, a `.git`
root as repository, and another directory as workspace.

## 3. Present fundamental-layer defaults

Knowledge, messaging, and tasks remain formal, exclusive slots. Their
implementations are capability packages called integrations.

| Layer | Default | Gives | Needs |
|---|---|---|---|
| knowledge | `oas.okf` | soul OKF bundle, instance memory, harvest | nothing |
| messaging | `oas.aweb` | instance identity and team messaging | `aw` CLI |
| tasks | none | choose Jira, Linear, or another integration | provider-specific |

Present these defaults to the user and ask before creating config. Common
choices: disable messaging for a solo repo; choose `oas.linear`/`oas.jira` for
tasks; use `--raw` for all layers off. Official integrations live in the
marketplace shipped with the kernel; `oas init` acquires the selected ones
into this scope's installed/ store (locked and trusted at acquisition). In an
interactive terminal with no layer flags, bare `oas init` prompts per layer;
through an agent, always pass explicit flags.

If the user keeps aweb messaging: declare the team in the deployment scope's
config (`team:` with a name; see the oas-config skill), then run
`oas aweb setup` — it checks the `aw` CLI, the aweb workspace at the team
scope, and team membership, and prints exactly the one next step each time
(including first-ever aweb account creation via `aw init`). Users who have
never used aweb just follow its prompts; nothing else is required.

Also ask whether they want normal mouse/trackpad scrolling in tmux agent
windows. Pass the answer explicitly when commands run through an agent, because
that shell is non-interactive:

```bash
oas init --tmux-mouse
oas init --messaging none --tmux-mouse
oas init --raw --knowledge oas.okf --no-tmux-mouse
oas init --tasks oas.linear --tmux-mouse
```

The scrolling option appends `set -g mouse on` to the existing `~/.tmux.conf`
or XDG tmux config and reloads a running server; it never changes terminal
keyboard mappings. An interactive terminal prompts when neither tmux flag is
provided.

`init` activates only packages explicitly represented by the layer choices;
it acquires the chosen marketplace layer capabilities into this scope's installed/ store, and does not activate anything else.

## 4. Decide shared capability targets

Ask whether reusable non-layer capabilities should apply to:

- every soul governed by this config (`global`);
- an explicit agent type (family — souls opt in via `type:` in soul.yaml); or
- one soul.

Do not invent agent types before the souls are known. Example after agents exist:

```yaml
agent-types:
  developers:
    description: Agents that build the product
capabilities:
  additive:
    vendor.code-review:
      from: installed
      agent-types:
        developers: true
```

External packages must be acquired/locked before activation; executable
commands/hooks need explicit trust:

```bash
oas install <git-url> --dir /path/to/workspace
oas trust vendor.code-review --dir /path/to/workspace
oas use vendor.code-review --type developers --dir /path/to/workspace
```

Acquisition never means activation and never silently updates a lock.

## 5. Verify

```bash
oas doctor /path/to/context --json
```

After creating a soul, use `--soul <name>` to inspect its exact capabilities,
skills, trust, and final generated `AGENTS.md` before spawn.

## 6. Create and spawn the first specialist

```bash
mkdir -p agents
oas create backend-expert --description "Owns backend architecture and implementation" --work worktree
# Optional: --type <agent-type> joins a declared family so typed config targets apply.
# Edit agents/backend-expert/soul/AGENTS.md: durable role, boundaries, workflow.
oas doctor . --soul backend-expert
oas spawn backend-expert --task "First concrete task"
oas status
```

The committed soul stays config-independent. Spawn generates instance
instructions and materializes only kernel + soul + active capability skills in
that instance. Do not put deployment-specific package prose into the soul.

Create/spawn only when asked. Suggest a team shape, then let the user decide.
For operations load the `oas` skill; for custom layer/package work use
`integration-authoring`; for deep architecture or bugs use `oas-support`.
