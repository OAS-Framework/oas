---
type: Area Guide
title: Knowledge typology
description: How OKF types map to souls vs instances — incarnation-invariance vs indexicality, types as consolidation stages, and the core/role-grown split.
tags: [memory, okf, types, core]
timestamp: 2026-07-08
---

Why each knowledge type lives where it does, derived from the ontology in
[what OAS is](/architecture/what-oas-is.md) rather than asserted.

# The derivation

A **soul** is identity across incarnations, so soul knowledge must be
**incarnation-invariant**: true and binding for any future instance, model, or
session. An **instance** is one incarnation's work, so instance memory is
**indexical** — saturated with *I / here / now* (this branch, this blocker,
this half-done plan). Indexical content cannot live in the soul: its referents
die at retirement.

**Harvest is de-indexicalization.** `notes/` is where an instance phrases the
residue of its work *without* I/here/now; triage checks whether that succeeded
(does it generalize, or was it secretly about one branch?). The promotion bar
("durable AND would change what a future instance does") is an invariance test.

# Types as consolidation stages

Types mark position on a consolidation gradient, not just category:

| Type | Home | Why |
|---|---|---|
| `Instance State` | instance only | Maximally indexical; **rewritten, not superseded** — deliberately exempt from the bundle honesty rule because working state is not history (log.md carries that) |
| `Finding` | instance notes | Observation with unproven durability — a proto-Lesson; passing triage is what makes it a `Lesson` |
| `Lesson` | born in notes, matures in soul | The consolidation product |
| `Decision` | both, different jurisdiction | Task-scoped decisions bind the rest of *this* task → STATE.md `# Context` / log.md; a `Decision` in notes/ or the soul binds all future incarnations. Location carries jurisdiction |
| `Playbook` | soul | Repeatability-across-incarnations *is* soul-ness; gradient continues: ad-hoc procedure → Playbook → (sometimes) skill |
| `Reference` | soul | External truth; zero indexicality by construction |
| `Area Guide` | soul | Orients arbitrary future readers; an instance's STATE.md is its own guide |

Corollary: an instance file's OKF-ness is proportional to its probability of
surviving the instance — STATE.md is minimal, log.md is a reserved file,
notes/ are full concepts because they are *future soul concepts written in
soul genre from birth*.

# Provenance: nobody's vocabulary but ours

The [OKF spec](/references/okf-spec.md) requires `type` but registers **no
vocabulary** — example values are non-normative, the ontology is delegated to
producers, and consumers must tolerate unknown types. Our tiers:

1. **Spec-exampled**: `Playbook`, `Reference` — named as (non-normative)
   example `type` values in SPEC.md itself, which even ships a full
   `Playbook` example. **Community-inherited**: `Lesson`, `Decision` —
   adopted from the community repos the okf skill distilled.
2. **Framework-minted, mechanics-bound**: `Instance State` — falls out of the
   spawn/harvest machinery itself; every instance has one.
3. **Role-grown**: e.g. this soul's `Roadmap` and `Area Guide`, and its
   `architecture/`, `deployments/`, `roadmap/` sections. Only souls whose role
   warrants them.

# Core vs role-grown sections

`scaffoldSoulKnowledge` (core.mjs) creates only the role-independent core for
every soul: `lessons/`, `decisions/`, `playbooks/`, `references/`, plus
`inbox/` (harvest landing zone, not a knowledge kind). Everything beyond is
**role-derived** — the knowledge ontology is itself part of the
specialization. A developer soul grows `codebase/`, not `roadmap/`; a
`Roadmap` concept in a developer soul is a smell (project-direction state
belongs to whoever stewards the project).

Test for growing a section — the promotion bar one level up: *would future
instances of **this** soul need to navigate this kind of knowledge?*

# Slow state in the soul

The soul holds not only timeless truth but **project-slow state**: `roadmap/`
and `deployments/` are present-tense at project timescale — STATE.md at ~100×
slower tick. Durability is a spectrum: task-fast (instance), project-slow
(soul, freshness-sensitive, `timestamp` matters), timeless
(lessons/references). Sections mark the difference.

# Where the package encodes this

Future agents see only the installed package, not this bundle. The operative
rules ship with the **oas-okf integration** (since the memory-agnostic-kernel
change): its **agent-memory** skill ("The type system" section:
core/stage/role-grown, task-Decision jurisdiction), its **okf** skill
(freeform-type note), and the `knowledge/index.md` its soul-scaffold hook
writes (invitation to grow role sections). Agents in `knowledge: none`
workspaces get none of this — the typology is an OKF-integration convention,
not a kernel guarantee. This concept is the canonical *why* behind the rules.
