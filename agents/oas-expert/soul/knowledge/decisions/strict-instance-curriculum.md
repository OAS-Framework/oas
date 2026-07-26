---
type: Decision
title: Instantiated souls receive a strict curated runtime curriculum
status: accepted
description: When OAS instantiates a soul, runtime adapters expose only the skills and instruction injections selected from the kernel, soul, and active capabilities, eliminating ambient skill noise while preserving provider-native tools and workflows.
tags: [architecture, skills, context, runtime, providers, composition]
timestamp: 2026-07-26
---

**Status: accepted by the founder 2026-07-26.** This decision supersedes the
ambient-skill coexistence behavior in [config authorship and ambient skill
coexistence](/decisions/config-authorship-and-ambient-skills.md). It restores
strict instance composition as a core product promise and strengthens [skill
layering](/architecture/skill-layering.md).

# Context

A specialized agent should not start with a catalog of a hundred unrelated
skills and hope the model ignores ninety-five of them. OAS already knows the
soul being instantiated, its agent type, its local config chain, and the
capabilities selected for it. Spawn can therefore construct the relevant
curriculum rather than exposing every personal, workspace, harness-package, or
ancestor skill.

OAS temporarily allowed harness-ambient skills to coexist to reduce adoption
friction. That made the OAS-managed set exact but the full visible skill set
non-deterministic: different machines could expose different skills, ambient
content could collide with selected content, and “no skill noise” could not be
an honest runtime claim.

The founder confirmed that curation at soul instantiation is fundamental OAS
value. Users who want a skill available to an agent should make that choice
explicitly through the soul or an assigned capability, not through accidental
ambient discovery.

# Decision

## Strict composition at instantiation

When OAS instantiates a soul, it resolves and materializes exactly:

1. kernel skills and baseline instructions required by every instance;
2. soul-private skills and canonical soul instructions;
3. skills and instruction injections from capabilities active for that soul
   under the resolved local config; and
4. explicit config-owned instruction blocks and approved overrides.

Runtime adapters expose this instance-local composition as the agent's skill
and instruction curriculum. They disable ambient discovery from user,
workspace, ancestor, harness-package, and unrelated project roots. The
pre-workspace getting-started bootstrap remains the narrow exception before an
OAS instance exists.

`instance.json` records the complete selected skill/injection surface and its
provenance. Duplicate names are resolved or rejected before launch according
to the existing explicit override contract; ambient last-writer-wins behavior
is not part of an OAS instance.

## Scope of “only what it needs”

Strict curriculum applies to discoverable agent skills and instruction
injections controlled by the OAS/runtime integration. It does not hide:

- the source files in the instance's assigned work tree;
- the explicit task briefing or prompts sent during the session;
- built-in tools and native interaction features of the selected harness; or
- provider-native workflows deliberately invoked by that specialist.

This distinction preserves provider strengths. A Claude Code developer may
still use Claude Code's native development workflow and tools; a Pi-based
coordinator keeps Pi's interaction model. What they do not receive is an
unselected ambient skill catalog or instruction set.

A provider plugin, channel, or runtime extension required by an active
capability is not ambient: it is part of the selected capability's declared,
locked, trusted composition and must appear in provenance.

## How users add skills

A skill reaches an instantiated soul through an explicit source:

- put role-private behavior in the soul;
- distribute reusable behavior in a package capability and assign it in
  `oas-config.yaml`; or
- add an explicit config-owned instruction block where appropriate.

This is more ceremony than ambient discovery, but it makes relevance,
portability, review, and diagnosis explicit. Package profiles may recommend
assignments, but local config remains authoritative and every capability stays
independently targetable.

## Runtime adapter requirement

Every supported runtime adapter must provide a verified strict launch mode:

- disable ambient skill and instruction discovery;
- expose only the instance-local OAS composition;
- preserve the runtime's built-in tools and native workflows;
- report unsupported or incomplete isolation as a launch/doctor error rather
  than silently falling back to ambient discovery; and
- carry parity tests proving the visible selected surface for each supported
  runtime.

The exact Pi and Claude Code mechanisms are implementation details and must use
supported runtime interfaces. The kernel remains provider-neutral; each thin
adapter enforces the same composition contract.

# Consequences

- “No skill noise” becomes an honest instantiation-time product promise: an
  OAS soul runs with the curriculum selected for its role and capabilities.
- The full skill/injection surface is deterministic and auditable, not only
  the OAS-managed subset.
- Personal or workspace skills stop leaking into OAS instances; users must
  package or assign them deliberately.
- Provider-native tools and workflows remain available, so strict curation
  does not flatten runtime strengths.
- Runtime adapters gain a fail-closed isolation obligation and parity tests.
- Current main does not yet satisfy this target contract; README present-tense
  wording must wait for the implementation/release that restores strict
  composition.

# Options considered

1. **Keep ambient coexistence and scope “no noise” to OAS-managed skills.**
   Rejected: the agent still sees unrelated skills and machine-specific
   collisions, weakening specialization at the actual runtime boundary.
2. **Make strict isolation optional.** Rejected as the default architecture:
   it turns the central curation promise into a deployment accident. A future
   explicit escape hatch would have to identify itself as leaving strict OAS
   composition and must not be silent.
3. **Remove provider-native tools and workflows too.** Rejected: OAS curates
   agent curriculum; it does not replace or deliberately cripple the chosen
   runtime. Provider strengths are part of why mixed-provider specialization
   is valuable.
