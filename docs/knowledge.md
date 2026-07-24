# Knowledge — layer 2

Specialization is accumulated judgment. A specialist remembers what worked,
what failed, what was decided, and which procedures are worth repeating.

OAS treats knowledge as a pluggable layer. The kernel does not choose a
memory format. The default integration, `oas-okf`, uses markdown OKF bundles
for soul knowledge and simple files for instance state.

## What the kernel does not own

The kernel is memory-agnostic. It provides lifecycle events:

- `soul-scaffold`
- `spawn`
- `retire`

A knowledge integration decides what to do with those events. If config
resolves `knowledge: none`, the kernel creates no `STATE.md`, no `notes/`, no
knowledge bundle, and no harvest flow.

The ideas behind any of this — what belongs in a soul vs an instance,
capture vs judgment, consolidation stages — are format-independent and live
in [knowledge theory](knowledge-theory.md).

## The default: oas-okf

With `knowledge: okf`, the integration creates two memory spaces.

| Space | Files | Purpose |
|---|---|---|
| Soul memory | `soul/knowledge/` | Long-term OKF bundle: lessons, decisions, playbooks, references, role-grown sections. |
| Instance memory | `STATE.md`, `log.md`, `notes/` | Current task state, dated history, and captured insights. |

The instance does not promote its own notes. It captures them, and after
committing with pending notes it runs `oas okf harvest` (its okf injection
carries this instruction), which spawns a **memory-harvest** agent. That
harvester judges the notes and updates the soul; the delivery matches the
soul's custody — a commit on the instance's branch for repo-resident souls,
a PR to the soul's home repo for workspace-mode souls, and **direct edits
with no commit** for local souls (their `local-agents/` home is
uncommitted by contract). Then it retires.

## Capture and judgment

OAS splits memory work into two roles.

**The working instance captures.** It keeps `STATE.md` current, appends
milestones to `log.md`, and writes every non-obvious insight to `notes/`.
It does not decide whether an insight is "important enough" for the soul.
Capture should be cheap and in-flow.

**The memory-harvest agent judges.** It reads pending notes and applies the
promotion bar:

> Promote only what is durable and would change what a future instance of
> this soul does.

For each note it chooses one outcome:

| Outcome | Meaning |
|---|---|
| Promote | Move it into the right soul knowledge section, or into a soul skill if it is procedural. |
| Merge | Fold it into an existing concept or skill. |
| Drop | Delete it and log why it failed the bar. |

This separation keeps working agents from overthinking memory, and gives
promotion the deliberate attention it deserves.

## Why instance memory and soul memory differ

Instance memory is indexical. It talks about this task, this branch, this
moment, this blocker. That is why it lives in `STATE.md`, `log.md`, and
`notes/`.

Soul memory must be incarnation-invariant. It should remain true for future
instances, future models, and future sessions. A future instance should be
able to read a concept and act differently because of it.

Harvest is the conversion between the two. Notes are where an instance tries
to phrase what it learned without "I, here, now". The harvester checks
whether that conversion succeeded.

## OKF concept types

OKF itself does not prescribe one vocabulary. OAS conventions use these
common types:

| Type | Usual home | Meaning |
|---|---|---|
| `Instance State` | `STATE.md` | Current working state. Rewritten, not superseded. |
| `Finding` | `notes/` | A captured observation whose durability is unproven. |
| `Lesson` | Soul knowledge | A durable behavior-changing conclusion. |
| `Decision` | `notes/` or soul knowledge | A decision and its rationale. Task-local decisions stay in `STATE.md` or `log.md`. |
| `Playbook` | Soul knowledge or soul skills | Repeatable steps. Procedure-shaped notes usually become skills. |
| `Reference` | Soul knowledge | External truth or stable internal reference. |

Souls start with core knowledge sections:

- `lessons/`
- `decisions/`
- `playbooks/`
- `references/`

Souls can grow role-specific sections such as `architecture/`, `codebase/`, or
`roadmap/`. Add a section when future instances of that soul need to navigate
that kind of knowledge.

## What a working instance should do

As you work:

1. Keep `STATE.md` accurate. A fresh session should be able to resume from
   its `# Next` section.
2. Append dated milestones and decisions to `log.md`.
3. Write non-obvious insights to `notes/` as one concept per file.
4. Before every commit, bring memory up to date.
5. Commit, then run `oas okf harvest` to send your notes to the soul.

Do not hold back a note because you are unsure it is soul-grade. Capture
first. The harvester judges.

## Without a knowledge integration

`knowledge: none` is valid. The agent gets no OAS memory files, no memory
briefing, no harvest agent, and no OKF skills. It may still use whatever
memory conventions the repo or harness already provides.
