---
name: soul-craft
description: >-
  How to author and maintain an agent's soul — its AGENTS.md/CLAUDE.md
  operating doc, soul.yaml config, and the balance between AGENTS.md, skills,
  and the OKF knowledge base. Use when creating a new agent (writing its first
  AGENTS.md), refining an existing soul that underperforms (agent ignores
  instructions, drifts from its role, bloated operating doc), reviewing a
  soul's setup, or deciding what goes in AGENTS.md versus a skill versus
  knowledge. Based on the agents.md standard and Anthropic CLAUDE.md guidance.
---

# Soul craft — author and maintain agent operating docs

A soul's `AGENTS.md` is loaded **every session of
every instance**. It is the most expensive real estate in the agent's context:
everything in it taxes every task, relevant or not. The craft is keeping it
minimal and pushing everything else to on-demand layers.

**Canonical files:** `AGENTS.md` and `.agents/skills/` are the canonical
sources; `CLAUDE.md` and `.claude/skills` must always be relative symlinks to
them, never independent files (the spawner creates these links — if you find a
real CLAUDE.md file diverging from AGENTS.md, that's a defect: merge and relink).

## The three-layer rule

| Layer | Loaded | Belongs there |
|---|---|---|
| **AGENTS.md** | always | Role, boundaries, the default workflow, memory pointers — only what applies to *every* session |
| **skills/** | on demand (description match) | Domain workflows, repeatable procedures ("how") — see `skill-craft` |
| **knowledge/** | on demand (index-first) | Facts, decisions, lessons ("what/why") — format per the knowledge integration (default okf) |

The test for every AGENTS.md line: **"would removing this cause mistakes in
most sessions?"** No → move it to a skill or a knowledge concept, or cut it.
Bloated operating docs cause agents to ignore the rules that matter — a rule
being ignored is usually a symptom of too many rules.

## Writing a soul's AGENTS.md

Structure that works (keep the whole thing short — a screen or two):

1. **Role, one paragraph.** Who this agent is, what it owns, where it stops.
   Boundaries beat capabilities: "you never merge", "you never modify the
   assignee", "UI belongs to the ui agent" prevent more damage than feature
   lists add value.
2. **Operating loop.** The default shape of a work session — for a developer:
   read ticket → plan in STATE.md → implement in ./work → verify → commit →
   review loop → hand off. Concrete, not aspirational.
3. **Verification.** How this agent checks its own work: the build/test/lint
   commands that must pass, what "done" means. An agent with a check it can
   run closes its own loop; without one, "looks done" is the only signal.
   Include exact commands the agent can't guess (`make test-unit`, not
   "run the tests").
4. **Memory pointers.** Where its knowledge and state live (knowledge base
   index, STATE.md discipline). Point, don't duplicate — the protocol lives
   with your knowledge integration (default okf: the memory-harvest skill).
5. **Escalation.** When to stop and ask the human or coordinator: the
   human-gate triggers (security, authz, migrations, contract breaks),
   plus "report to your spawner, don't self-fix" for infrastructure faults.

Style rules (from the agents.md standard + field experience):
- Write commands, not prose: `pnpm vitest run -t "<name>"` beats "run the
  relevant test".
- Include only what can't be inferred from the repo: conventions that differ
  from defaults, env quirks, etiquette (branch naming, PR format).
- Exclude: standard language conventions, file-by-file codebase tours, API
  docs (link instead), anything that changes weekly (that's knowledge),
  self-evident advice ("write clean code").
- Emphasis (**IMPORTANT**, YOU MUST) sparingly — it works, and it stops
  working when everything is emphasized.
- The repo's own AGENTS.md (in ./work) covers repo mechanics — the soul doc
  covers the *role*. Don't duplicate the repo doc; instruct reading it.

## soul.yaml

Keep honest: `repo` (what it works on), `work` (worktree for builders,
checkout for reviewers/coordinators), `runtime`, `model` (only pin when the
role needs a specific one — reviewers on a different model than authors),
`description` (one line; shows in rosters and pickers).

## Maintaining a soul

- **Change AGENTS.md rarely and deliberately** — it defines the agent. The
  bar: a change in how the agent fundamentally operates, proven by instance
  experience. Day-to-day lessons go to knowledge; procedures to skills.
- When an instance repeatedly misbehaves, diagnose in order: (1) is the rule
  drowning in a bloated doc? → prune the doc; (2) is it ambiguous? → sharpen
  with a command or example; (3) is it missing? → add it, minimally. Test by
  observing the next instance's behavior, not by rereading.
- **Prune on every edit.** Adding a line? Look for two to cut.
- Log every soul change in `knowledge/log.md` (`**Update**: AGENTS.md — …`)
  so the soul's evolution is reconstructible.
- Agents never rewrite their own role or safety boundaries; soul changes that
  alter behavior go through the human (or a documented review workflow).
- Periodic review (worth doing when spawning feels off): does the role still
  match reality? Do skills cover the recurring procedures? Is the knowledge
  index current? Are the verification commands still correct?

## Bootstrapping a new soul

Fastest path to a *grounded* soul (never write one from imagination):
1. Do (or supervise) the role's work once in a plain session, noting
   corrections, commands, and conventions as you go.
2. Distill: role/boundaries/loop/verification/escalation → AGENTS.md;
   repeated procedures → first skills; facts and decisions → first knowledge
   concepts.
3. Spawn an instance on a real task; watch where it stumbles; fold the
   corrections back (doc, skill gotcha, or concept — per the three-layer rule).
Two rounds of this beat any amount of upfront authoring.
