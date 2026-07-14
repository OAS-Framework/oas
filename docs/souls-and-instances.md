# Souls and instances

Souls and instances are the two layers the OAS kernel owns. A soul is the
expert. An instance is a named incarnation of that expert, with its own ID,
home, worktree, and lifecycle. It is not the same thing as one chat session.

## Soul anatomy

A soul is durable and committed. It is the part you review, improve, and keep.

```text
<agents-root>/<agent>/soul/
  soul.yaml            # name, repo, work mode, runtime, model
  AGENTS.md            # canonical operating doc
  CLAUDE.md → AGENTS.md
  skills/              # skills specific to this expert
  knowledge/           # optional, created by the knowledge integration
```

`soul.yaml` keys:

| Key | Meaning |
|---|---|
| `name` | Agent name. |
| `kind` | `persistent` for committed agents, `tmp` for local agents. |
| `description` | Short role description. |
| `repo` | Target repo, absolute or relative to the agents root's parent. |
| `work` | `worktree` or `checkout`. |
| `runtime` | `pi` or `claude`. |
| `model` | Optional default pi model, `provider/id`. A spawn can override it. |

A soul is model-agnostic as an artifact. Its files are plain operating docs,
skills, and knowledge. `model` is only the default choice for new instances,
not part of the expert's identity.

A soul never runs by itself. It is incarnated as an instance. Editing a soul
is a code change.

Today the core soul artifacts are `AGENTS.md`, `skills/`, and any knowledge
bundle the knowledge integration creates. Future integrations may add other
expert-specific artifacts, such as Claude Code-like rule files or
runtime-specific guidance, while keeping `AGENTS.md` canonical.

## Instance anatomy

An instance is transient, but it is not a single chat session. It is the
identity of one instantiated soul while that work is alive. Several sessions,
compactions, restarts, or model switches can happen inside the same instance
before it is retired.

An instance has a home directory, a task, and a worktree when the work mode
needs one. Its runtime setup is composed from the canonical soul plus
capabilities selected for that soul by the config scopes governing it.

A soul can have as many instances as people need. Instances are transient and
normally gitignored (`agents/*/instances/`). That matters for large or open
source repos: the expert souls can travel with the repo, while different
engineering teams instantiate those souls into their own local agent teams.
Their instance homes, logs, notes, branches, and messaging identities do not
collide because they are local runtime state, not shared soul state.

```text
<agents-root>/<agent>/instances/<instance>/
  soul → <agent>/soul/             # the agent setup for this instance
  AGENTS.md                        # generated: canonical soul + selected blocks
  CLAUDE.md → AGENTS.md
  .agents/skills/                  # exact soul + active capability set
  .claude/skills → ../.agents/skills
  work/                            # worktree, checkout symlink, or attached tree
  TASK.md                          # briefing and task
  instance.json                    # repo/branch, spawn lineage, capabilities, skills, instructions, trust
  STATE.md, log.md, notes/         # optional, from the knowledge integration
```

Why some knowledge belongs in the soul (incarnation-invariant) and some in
the instance (this task, this branch, now) — regardless of which integration
or format you use — is covered in [knowledge theory](knowledge-theory.md).

The kernel does not define memory files. If the config resolves `knowledge:
okf`, the okf integration creates `STATE.md`, `log.md`, and `notes/`. If the
config resolves `knowledge: none`, those files do not exist.

## Lifecycle

### Spawn

The kernel creates the home, links the soul for reference, resolves capability
targets, generates instance instructions, materializes the exact local skill
set, prepares `work/`, runs active capability hooks, writes `TASK.md`, and
launches a full coding agent session in tmux. The committed soul is unchanged.
This is not a Claude Code subagent call; it is a normal agent process with its
own home and tools.

Examples of spawn hooks:

- `oas-okf` creates episodic memory files.
- `oas-aweb` mints a messaging identity.

### Work

The instance works in `./work`. With oas-okf it also keeps `STATE.md` current,
appends milestones to `log.md`, and captures non-obvious insights in
`notes/`.

After committing with pending notes, the instance runs `oas okf harvest`
(its okf briefing says so). oas-okf spawns a memory-harvest agent attached to
the same work tree. The harvester promotes, merges, or drops notes, commits a
`memory-harvest:` change, deletes processed notes, and retires itself. This is
how long-lived instances feed their souls while still alive.

### Spawning and coordinating with other agents

OAS agents can run `oas spawn` when their instructions or the
human ask them to create another expert instance. The spawned agent is another
full OAS instance, with its own soul, home, worktree, and lifecycle.

If the workspace has a messaging integration such as aweb, spawned instances
can also receive identities and coordinate with each other automatically. The
task layer can provide shared work state while messaging provides conversation.

### Retire

Retirement runs active capability retire hooks in reverse spawn order before the home disappears. The aweb
integration self-deletes the instance identity here. For oas-okf, retirement
is a knowledge no-op because harvest already happens after commits.

`oas retire <instance> --self` lets an instance retire itself when the human
or briefing says it is done. It runs hooks and removes the home first, then
delays the tmux window kill for a few seconds so the instance can report
final status.

## Work modes

A work mode decides what `./work` points at and what discipline the agent must
follow.

### `worktree` — isolated branch

`work/` is a git worktree on the instance's own branch, by default
`agents/<instance>`.

Use this for agents that will edit code or docs independently.

Rules:

- Start in `work/` and stay there.
- Build, test, and commit from `work/`.
- Never edit from the main checkout or the home root.
- Do not create extra worktrees. Ask for another instance if parallel work is
  needed.

A config may define `work-modes.worktree.setup`. The kernel runs that command
inside each fresh worktree. Failures warn but do not block spawn.

### `checkout` — shared current branch

`work/` is a symlink to the repo checkout itself.

Use this for maintainers, coordinators, auditors, or agents working on the
repo's current state.

Rules:

- Stay on the currently checked-out branch.
- Do not switch branches unless explicitly asked.
- Avoid destructive git operations unless the human explicitly asks.

### `attached` — another instance's tree

`work/` points at **another instance's work tree** — same branch, same
uncommitted state. Spawning attached requires `workDir` (the owning
instance's `<home>/work`); it is usually a spawn-time choice for service
agents (the memory-harvest agent uses it so its promotion commit lands on
the source instance's branch), but a soul whose role is always-attached
service work may declare it as identity too.

Attached agents are guests: never switch branches or rewrite history, touch
only what the briefing names, keep commits small and attributable. Retiring
an attached instance never removes the shared tree. The packaged
`work-attached` instruction source carries this discipline into each generated instance AGENTS.md.

## Agents root

The agents root is the nearest `agents/` directory walking upward from the
current directory. `PI_AGENTS_ROOT` overrides the search.

Default layout:

```text
agents/
  docs-expert/
    soul/
    instances/
  local-agents/
    scratch-agent/
      soul/
      instances/
```

`local-agents/` holds uncommitted agents created from ad hoc instructions or
imported agent definition files. Legacy `tmp-agents/` roots are still read for
compatibility.

Alternative agents-root layouts are planned but not built. Today the default
layout is the only implemented layout.
