---
name: skill-craft
description: >-
  How to create, evaluate, and maintain agent skills (SKILL.md files per the
  Agent Skills standard). Use when writing a new skill, improving or debugging
  an existing one (skill not triggering, agent ignoring instructions, skill too
  long), turning a repeated procedure or correction into a skill, deciding
  whether knowledge belongs in a skill versus the knowledge base versus
  AGENTS.md, bundling scripts into skills, or evaluating whether a skill
  actually helps. Based on the agentskills.io creator guides and Anthropic
  best practices.
---

# Skill craft — create, evaluate, maintain

A skill is a directory with a `SKILL.md` (YAML frontmatter + markdown body),
optionally `scripts/`, `references/`, `assets/`. Agents load only `name` +
`description` at startup; the body loads **only when the description matches
the task** — the description carries the entire burden of triggering.

## Where does this knowledge belong? (decide first)

- **Repeatable procedure** ("how to do X, again and again") → **skill**.
- **Declarative fact/decision/lesson** ("what is true and why") → **OKF
  concept** in the knowledge base (see `okf` skill). Skills may reference
  concepts for the why.
- **Applies to every session of this agent** (role, boundaries, core workflow)
  → **AGENTS.md** (see `soul-craft`). Rule of thumb: AGENTS.md is loaded
  always — keep it minimal; skills load on demand — put domain workflows there.

## Creating a skill

**Ground it in real expertise — never generate from thin air.** The valuable
content is what a capable model *doesn't* already know: your APIs, your
conventions, the corrections you had to make. Best sources: a hands-on task
you just completed (extract the steps that worked, the corrections given, the
formats used), runbooks, review comments, real failures and their fixes. A
skill with generic content ("handle errors appropriately") is worthless — cut
or ground it.

**Frontmatter rules** (spec + hard-won):
- `name`: lowercase alphanum + hyphens, ≤64 chars, **must match the directory
  name**, no leading/trailing/double hyphens.
- `description`: ≤1024 chars, non-empty. ⚠️ **Use a `>-` block scalar if it
  contains any `: ` colon-space** — an unquoted colon breaks YAML parsing and
  the skill silently fails to load. Verify new skills actually load.

**Write the description for triggering** (it's the only thing the agent sees
before deciding):
- Imperative: "Use when..." not "This skill does...".
- Name the **user intents** it serves, not the implementation. Include
  trigger phrases users actually say, and cover cases where they don't name
  the domain ("even if they don't mention X").
- Precise beats broad: an over-broad description fires on near-miss tasks
  and pollutes context.

**Write the body for a loaded context window** — it competes with everything
else once loaded:
- **Only what the agent would get wrong without it.** For every line ask:
  "would removing this cause mistakes?" No → cut.
- ≤500 lines / ~5k tokens. Larger → move detail to `references/` and tell the
  agent **when** to load each file ("read references/errors.md if the API
  returns non-200"), not just that it exists.
- **Defaults, not menus**: pick one tool/approach, mention alternatives in
  one line. Match prescriptiveness to fragility: fragile sequences get exact
  commands ("run exactly this"); judgment tasks get goals + why.
- Procedures over answers: teach the approach that generalizes, with one
  concrete worked example.
- **Gotchas section** — often the highest-value part: concrete corrections to
  mistakes the agent *will* make ("the /health endpoint lies; use /ready").
- For multi-step workflows: an explicit checklist. For fragile output: a
  template (agents pattern-match better than they follow prose). For
  correctness-critical work: a validation loop (do → validate → fix → repeat)
  or plan-validate-execute with a validator script.

**Scripts**: when you see an agent reinventing the same logic across runs,
write it once, test it, bundle it in `scripts/`, and reference it from the
body with exact invocations. Prefer zero-dependency scripts; pin versions for
`npx`/`uvx` one-offs. Scripts should print errors an agent can self-correct
from ("field X not found — available: a, b, c").

## Evaluating (before trusting)

- **Trigger check**: draft ~10 realistic prompts that *should* fire the skill
  (varied phrasing, some not naming the domain) and ~10 near-misses that
  *shouldn't* (share keywords, need something else). Run them; the skill
  triggered if its body was loaded. Fix the description, not the body, for
  trigger failures.
- **Output check**: run 2-3 real tasks **with and without** the skill. If
  with-skill isn't clearly better, the skill isn't earning its context — cut
  or sharpen it. Read execution traces, not just outputs: wasted steps mean
  vague instructions, inapplicable instructions being followed, or menus
  without defaults.

## Maintaining

- **Every correction is a candidate gotcha.** When a human (or reviewer)
  corrects an agent following the skill, add the correction to the gotchas —
  this is the single best maintenance loop.
- Treat skills like code: prune on every edit; if the agent ignores a rule,
  the skill is probably too long and the rule is drowning. Test behavior
  changes by observing runs, not by rereading the text.
- Never let a skill grow past one coherent unit of work — split like you'd
  split a function.
- Log skill changes in the soul's `knowledge/log.md` (`**Update**: skills/x —
  added gotcha about …`) so knowledge history and skill history stay one
  timeline. Knowledge maintenance and skill maintenance are the same duty:
  declarative lessons go to OKF concepts, procedural lessons go to skills,
  and each should link to the other.
