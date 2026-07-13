---
name: memory-harvest
description: >-
  Protocol for the memory-harvest agent: promote a live instance's pending
  notes into its soul — knowledge concepts into the right bundle sections,
  procedure-shaped notes into soul skills (new or maintained) — then commit
  on the shared work tree and retire. Use when you are a memory-harvest
  instance, or when manually promoting notes/ into a soul. Covers the
  promote/merge/drop decision, knowledge-vs-skill routing, index and log
  discipline, and the harvest commit.
---

# Memory harvest — promoting notes into the soul

You process the pending `notes/` of a **live, still-running instance**. Its
notes are promotion candidates. Your job is judgment plus bookkeeping, then
getting out of the way.

## Ground rules

- You are ATTACHED to the source instance's work tree (`./work` is shared).
  Its owner keeps working while you run. Touch ONLY the soul dirs named in
  your briefing and the source `notes/` files. Nothing else.
- The source instance is alive but cannot be interviewed. Judge notes on
  what they say, not what they might have meant.
- Never embellish. You move and merge claims. You do not strengthen them.

## Per note: three outcomes

Judge each note against the promotion bar — **durable AND would change what
a future instance of this soul does**. Session trivia, one-off fixes, and
anything derivable from the repo in seconds fail the bar. The source
instance captured without judging; judging is exactly your job:

- **Promote** — move it into the right home (see routing below), fix links,
  update the section index listing.
- **Merge** — fold into an existing concept or skill, delete the note.
- **Drop** — delete it, log one line saying why.

## Routing: knowledge vs skill

The shape of the content decides where it lives:

| Note contains | Home | Test |
|---|---|---|
| A fact, decision, gotcha, reference | `knowledge/<section>/` | "future instances should KNOW this" |
| A repeatable procedure (steps to run again) | `skills/<name>/SKILL.md` | "future instances should DO this the same way" |
| A correction to an existing procedure | the existing skill's Gotchas | maintenance, not new knowledge |
| Both (a lesson that implies a procedure) | knowledge concept + skill references it | split, link them |

For skill work follow the **skill-craft** skill (trigger-rich description,
procedure, gotchas). New skills need a clear repeat-use case — a one-off fix
is a Lesson, not a skill.

## Types when promoting

`type` is freeform (consumers tolerate unknown types). Conventions: a
`Finding` (unproven observation) that passes the bar becomes a `Lesson`.
A `Decision` promotes only if it binds future incarnations — task-scoped
decisions die with the task. `Playbook` = repeatable steps kept as
knowledge; if instances should RUN it the same way every time, it wants to
be a skill instead. Souls also grow role-specific types and sections — list
new sections in the bundle index and log the growth.

## Bookkeeping (non-negotiable)

1. Every promoted concept: correct frontmatter, listed in its section's
   `index.md`, one `log.md` entry per outcome (Creation/Update/Removal —
   okf skill has the conventions).
2. Skill changes: log in the soul's `knowledge/log.md` too
   (`**Update**: skills/x — ...`).
3. **Delete processed notes from the source `notes/` dir** — promoted,
   merged, and dropped alike. Leftovers get re-harvested next commit.
4. Validate: run the okf skill's `scripts/okf-validate.mjs <bundle> --strict`
   — must pass.

## Finish

1. One commit on the shared tree with everything you changed, message
   prefixed `memory-harvest:` — e.g.
   `memory-harvest: 2 lessons + 1 skill gotcha from worker-x notes`.
2. `oas retire <your-instance> --self` from your home. Do not linger — the tree belongs
   to its owner.
