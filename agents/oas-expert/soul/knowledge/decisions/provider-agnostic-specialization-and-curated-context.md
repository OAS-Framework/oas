---
type: Decision
title: Provider-agnostic specialization and curated agent context
status: accepted
description: OAS is positioned as the provider-agnostic framework that makes specialized agents first-class project artifacts, curates each agent's OAS-managed curriculum, compounds expertise, and coordinates mixed-runtime teams without flattening provider strengths.
tags: [architecture, positioning, specialization, providers, skills, context, readme]
timestamp: 2026-07-26
---

**Status: accepted by the founder 2026-07-26.** This decision defines the
product narrative that the README and explanatory documentation must lead
with. It complements [what OAS is](/architecture/what-oas-is.md), [skill
layering](/architecture/skill-layering.md), and the [distribution package
architecture](/decisions/distribution-packages-config-profiles-and-requirements.md).

# Positioning

OAS is a **provider-agnostic framework for making specialized agents durable,
versioned members of a project**. Each specialist receives a curated
curriculum, builds expertise over time, and can coordinate as a full team
member while its chosen runtime and model retain their native strengths.

The value is not one more universal assistant, model router, or rigid workflow
engine. OAS makes the agent team itself part of project architecture:
identities, roles, knowledge, procedures, deployment policy, capability
assignment, work topology, and coordination are explicit artifacts rather than
session side effects.

# Value pillars

## First-class specialists

A soul is a reviewed project artifact describing a durable specialist. An
instance is a full, steerable incarnation with its own work context and
lifecycle, not merely an anonymous hidden tool call. Agents can be addressed,
coordinated, inspected, resumed, and retired as team members.

OAS documentation should explain what this adds without dismissing
provider-native subagents or workflows. Those mechanisms remain useful. OAS
provides durable identity, project ownership, curation, continuity, and team
coordination around them.

## Curated curriculum

Specialization is deliberate context selection. Local config determines which
OAS-managed instructions, skills, capabilities, settings, and knowledge apply
to each agent type or individual soul. Spawn materializes that selected
curriculum and records its provenance.

The goal is relevance, not maximal context. A design specialist should receive
design knowledge and procedures rather than every development workflow; a
reviewer should receive review protocols rather than the whole authoring
catalog. This reduces OAS-managed skill noise and makes the resulting agent
surface auditable.

## Compounding expertise

Durable souls outlive disposable instances, sessions, context windows, model
changes, and provider changes. A knowledge integration can capture instance
learning and promote durable lessons and procedures back into the soul. Future
incarnations start with the useful expertise earned by earlier ones.

## Coherent mixed-provider teams

OAS intentionally allows different team roles to use different runtimes and
models. A coordinator and reviewer may use one model family, developers may
use Claude Code and its native development workflows, and a design specialist
may use a design-strong model without development workflows. OAS supplies the
common identity, curriculum, configuration, memory, communication, and work
contracts; it does not flatten every member into a lowest-common-denominator
runtime.

Provider diversity is a feature when specialization makes the choice
intentional. Runtime/model selection belongs to the role and instance, while
the soul remains portable.

## Portable distribution with local control

Reusable behavior travels in packages, but deployment policy stays local.
Package profiles are recommended snapshots rather than remote mandatory
policy. Every exported capability remains independently targetable; local
config may enable, disable, retarget, or change settings for any family or
soul.

# Provider-agnostic fundamental layers

“Provider-agnostic” has two different provider axes that documentation must not
conflate:

1. **Agent runtime/model providers** — Pi, Claude Code, model vendors, and
   future harnesses. OAS contracts must not assume one of them.
2. **External service providers** — the concrete knowledge, messaging, or task
   system selected by a deployment.

An integration may deliberately bind one external service provider, such as a
particular messaging or task service. But the OAS capability that satisfies a
fundamental knowledge, messaging, or tasks layer must expose an
agent-runtime/model-neutral protocol. The same layer capability should compose
and behave coherently for Pi, Claude Code, and future runtime adapters.
Runtime-specific glue stays thin and at the edge.

The kernel remains runtime-neutral. Fundamental layer capabilities should
prefer plain files, stable CLI/module contracts, and generated instructions
over model-provider APIs or harness-only workflow assumptions.

# The explanatory mental model

The README should teach this compact sequence:

> **Package distributes. Capability teaches or enables. Config assigns. Soul
> specializes. Instance works.**

- A **package** is the install, update, integrity, and review unit, normally a
  Git repository. It may ship several capabilities and recommended config
  profiles. Installation makes resources available and activates nothing.
- A **capability** is one independently targetable unit of reusable behavior:
  skills, instructions, commands, agents, or lifecycle hooks. An integration
  is a capability that fills one exclusive fundamental layer.
- **OAS config** is local deployment policy. It declares agent types and
  assigns capabilities, layers, settings, and exclusions to types or souls.
  An adopted profile becomes an ordinary editable snapshot, and local config
  remains authoritative.
- A **soul** is the durable, versioned specialist identity and curriculum.
- An **instance** is the disposable full incarnation that does work and can be
  steered.

Detailed schemas, manifests, locks, and lifecycle reference should follow this
mental model rather than lead the README.

# Strict skill-curation claim

Under the accepted [strict instance curriculum](/decisions/strict-instance-curriculum.md),
spawn materializes the kernel, soul, and active-capability skills and
instruction injections selected for the soul, records their provenance, and
runtime adapters disable ambient skill/instruction discovery.

The product claim is specifically instantiation-time curriculum control:

> When OAS instantiates a soul, the agent sees the skills and instruction
> injections selected for its role and active capabilities—not an ambient
> catalog of unrelated skills.

Strict curation does not remove source files, explicit prompts, built-in tools,
or provider-native workflows. It preserves runtime strengths while eliminating
unselected skill noise. Current main still carries the superseded ambient
coexistence behavior, so present-tense README wording waits for the release
that implements strict runtime-adapter enforcement.

# README direction and timing

The README should lead with:

1. the one-sentence positioning;
2. the value pillars;
3. the package/capability/config/soul/instance mental model;
4. one concrete mixed-provider team;
5. compounding expertise;
6. provider-agnostic layers;
7. a short deployment/trust explanation; and
8. a brief verified getting-started path with links to focused reference docs.

The ground-up rewrite lands with the distribution-package architecture after
engine, config/profile, and official-package workstreams converge. Present-tense
README claims must match the released implementation and published package
probes. Before that release, only focused corrections to stale current-main
claims should land; target architecture must not be documented as already
shipped.

# Consequences

- Product messaging leads with specialization, curation, continuity,
  coordination, and provider plurality rather than a long feature inventory.
- Provider-native workflows are preserved and framed as strengths used by
  specialist roles.
- Fundamental layer implementations are judged for runtime/model neutrality,
  even when they bind a concrete external service.
- Config ownership and independent capability targeting are core user value,
  not schema trivia.
- “No skill noise” is an instantiation-time contract for skills and instruction
  injections; runtime adapters must enforce it before the README makes the
  claim in the present tense.
