---
name: knowledge-integration
description: >-
  Building a knowledge-layer OAS integration (replacing or extending the
  default OKF format) — what the kernel contract guarantees vs what the
  format owns, and how to teach a different knowledge discipline. Use when
  integrating a knowledge format other than OKF or customizing knowledge
  conventions. Triggers: "knowledge integration", "replace OKF", "custom
  knowledge format", "knowledge layer".
---

# Knowledge-layer integrations

**The knowledge integration owns EVERYTHING memory** — the kernel is
memory-agnostic. Agents without a knowledge integration get no STATE.md, no
log.md, no notes/, no soul knowledge dir, no harvest: whatever the repo or
coding agent already defines is all they have. Load integration-craft first.
Template: `capabilities/oas-okf/` — read `bin/oas-okf.mjs` fully.

## What your integration must provide (the okf reference shape)

Everything below is YOUR scaffolding, delivered via hooks — the kernel only
provides the hook points and env:

- **`soul-scaffold` hook** — called at soul creation (OAS_SOUL = soul dir):
  create your long-term memory structure (okf: `knowledge/` bundle with
  index/log/core sections; honor `settings["sections-file"]` for seeding).
  Must be idempotent — it's also called lazily at spawn for older souls.
- **`spawn` hook** — create the instance's episodic memory (okf: STATE.md +
  log.md + notes/; OAS_TASK/OAS_REPO/OAS_BRANCH/OAS_WORK env available) and
  return a `brief` telling the instance how to use its memory — that line is
  the ONLY memory instruction TASK.md will carry.
- **Optional `retire` hook** — consolidate before deletion only if the format
  needs retirement-time work. Current okf harvests continuously after commits,
  so retirement is intentionally a knowledge no-op.
- **Skills**: the format craft (okf skill) and the consolidation judgment
  (memory-harvest skill — promotion bar, knowledge-vs-skill routing). The
  INSTANCE-facing protocol goes in your injection, not a skill: instances
  just capture and commit; judgment belongs to your harvest agent.
- **The injection**: name the format, name both skills, point at the soul
  memory entry point.
- **Validation tooling**: zero-dependency script in the skill (`scripts/`).

## Kernel touchpoints you rely on (and cannot change)

- Hook env contract + JSON output (`meta`/`brief`/`warning`); failures warn,
  never block.
- The kernel's session automation (compaction journaling, resume nudges)
  activates only if YOUR files exist (it checks for STATE.md/log.md) — name
  differently and you own session continuity yourself.
- promotion/handoff is your convention, not the kernel's. Instance dirs are
  deleted at retire, so complete continuous promotion first or provide an
  explicit retire hook.

## The bar for replacing OKF

OKF is plain markdown + YAML frontmatter + links — deliberately minimal.
Before building a replacement, check the user isn't actually after one of:

- **extra scaffold sections** → a setting on the selected knowledge capability
  (for example `settings.sections-file` if that package supports it)
- **role-grown types** → just write them; consumers tolerate unknown types
- **different validation strictness** → wrap/extend the okf validator

A real replacement makes sense for: org-mandated formats, non-markdown
constraints, tooling lock-in (Obsidian/Notion-specific), or structured
metadata needs beyond frontmatter.

## Testing extras

- Scaffold a fresh soul under your config → write concepts per your format →
  run your validator → PASS.
- Simulate a full cycle: instance writes notes/ in your format → retire →
  harvest lands in inbox/ intact → triage per your conventions works.
- Coexistence: a laptop with okf and a workspace with yours — both resolve
  correctly, skills scoped to each.
