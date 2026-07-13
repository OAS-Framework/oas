---
type: Area Guide
title: What OAS is
description: The Open Agent Specialization pattern — durable souls, disposable instances, harvest-back — and the claim it makes.
tags: [pattern, core]
timestamp: 2026-07-08
---

OAS (Open Agent Specialization) is a pattern for building **specialized agents
that are part of a team**. The claim: agent expertise should be a versioned
artifact, not a session side-effect.

# The model

- A **soul** is what an agent *is*: its operating doc (`AGENTS.md`), config
  (`soul.yaml`: target repo, work mode, runtime, default model), its `skills/`,
  and its accumulated long-term `knowledge/` (an OKF bundle). Souls are
  committed templates — they travel and grow with the repo. No identity.
- An **instance** is a running incarnation of a soul, spawned for one piece of
  work, with its own home dir, work tree, episodic memory
  ([memory design](/architecture/memory-design.md)), and tmux session.
  Instances are transient — retired when done.
- **Harvest**: at retirement, the durable notes an instance wrote are moved
  into its soul's `knowledge/inbox/` for triage. Expertise is **soulbound**:
  instances die, models change, the specialist remains — and every incarnation
  starts wiser than the last.

The pattern names five needs of a specializing agent: a **soul**, a
**knowledge form**, **instances**, a **messaging layer** (unique identity +
team comms), and a **task layer**. The kernel implements the first and third
natively and defines the contracts; concrete tools plug in as providers
(oas-okf, oas-aweb, hand-rolled Jira — see
[kernel and providers](/decisions/kernel-and-providers.md)).

One soul backs many concurrent instances. Specialization compounds: a repo's
developer soul after 40 incarnations knows the codebase's gotchas, decisions,
and playbooks in a way no fresh session can.

# What makes it "open"

- Built on open standards: [OKF](/references/okf-spec.md) for knowledge,
  [Agent Skills](/references/agent-skills-standard.md) for procedures,
  [agents.md](/references/agents-md-standard.md) for operating docs.
- Harness-agnostic by construction: souls run on pi or Claude Code today
  (canonical `AGENTS.md` + symlinked `CLAUDE.md`, canonical `.agents/skills` +
  symlinked `.claude/skills`); the layout is plain files any harness can read.
- Reference implementation: [the oas pi extension](/architecture/implementation.md).

# Origins

Derived from the a2am team architecture (souls/instances/aw identities,
spawn-instance skill) and an agent-native engineering vision developed at a
multi-repo workspace (repos carrying their own specialists), where OAS was
first deployed.
