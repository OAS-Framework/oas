---
type: Area Guide
title: Memory design
description: Three memory kinds — skills (how), knowledge (what/why), state (where am I) — with OKF bundles for souls and STATE.md/log.md/notes/ for instances.
tags: [memory, okf, core]
timestamp: 2026-07-10
---

Memory is the heart of specialization. Three kinds, cleanly separated:
**skills = procedural, knowledge = declarative, state = episodic.**

**Ownership (since 2026-07-09): the knowledge integration owns ALL of this.**
The kernel is memory-agnostic — it provides soul-scaffold/spawn/retire hook
points; oas-okf's hooks scaffold the bundle and STATE.md/log.md/notes/,
harvest at retire, and ship the okf + agent-memory skills. `knowledge: none`
⇒ no memory machinery at all. The design below describes the OKF integration's
conventions, not kernel guarantees.
For why each OKF type lives where it does — invariance vs indexicality,
consolidation stages, core vs role-grown sections — see the
[knowledge typology](/architecture/knowledge-typology.md).

# Soul memory (long-term)

`soul/knowledge/` is a full [OKF](/references/okf-spec.md) bundle: small typed
markdown concepts (`Lesson`, `Decision`, `Playbook`, `Reference`) with
frontmatter, cross-linked, `index.md` for progressive disclosure, `log.md`
for history. Agents read **selectively** (index-first), never bulk-load; that
read-side instruction must be explicit, not assumed (see [OKF injection was
write-biased](/lessons/okf-injection-read-side-gap.md)). Instance homes link
`./soul` to the shared soul directory rather than copying it so harvest
write-back stays live (see [Instances symlink the soul rather than copy
it](/decisions/soul-knowledge-symlink-rationale.md)).

# Instance memory (episodic)

- `STATE.md` — singleton concept (`type: Instance State`) with
  `# Task / # Plan / # Progress / # Next / # Context`, **rewritten** as work
  progresses. The test: a fresh session on any model resumes from files alone.
  `# Next` always names the single next action.
- `log.md` — append-only dated journal (OKF log format, newest first).
- `notes/` — one OKF concept per durable insight; promotion candidates.

# Automation (pi hooks, active when PI_AGENT_HOME is set)

- `session_compact` → compaction summary auto-appended to instance log.md +
  steered nudge to refresh STATE.md. Zero agent discipline required.
- `session_start` (resume/new with touched STATE.md) → inject "read STATE.md,
  continue from Next" — model-switch continuity.
- **Continuous harvest (post-commit, since 2026-07-09)**: a git commit by an
  instance with pending notes/ spawns a **memory-harvest** agent ATTACHED to
  the committer's work tree (new work mode: sibling home, shared tree). It
  promotes/merges/drops each note — knowledge to bundle sections, procedures
  to soul skills — commits `memory-harvest:`-prefixed, deletes processed
  notes, retires itself. Loop guard + one-harvester-per-source debounce.
  Repo-resident souls are updated THROUGH the worktree so promotions ride
  the instance's own branch.
- Retirement is a knowledge no-op: no inbox, no retirement harvest. The okf
  injection instructs instances to bring memory current BEFORE every commit;
  notes never committed die with the home. Rationale: long-lived sessions
  feed the soul while alive instead of hoarding until death.

# The promotion bar — and who holds it

Soul writes must be **durable AND would change what a future instance does**.
Since 2026-07-09 the bar is held ONLY by the memory-harvest agent (its skill
carries the judgment: bar, Finding→Lesson, knowledge-vs-skill routing).
Instances are told to CAPTURE without judging — write every non-obvious
insight to notes/, keep STATE/log current, commit — via the okf AGENTS.md
injection. The agent-memory skill is retired; separation of capture (cheap,
in-flow) from judgment (deliberate, harvester's) replaces it.

Rationale for the asymmetry (full OKF for souls, simple files for instances):
souls have selective-read access patterns over months (OKF's home turf);
instances need total-read-at-boot working state (one small file beats a graph).
