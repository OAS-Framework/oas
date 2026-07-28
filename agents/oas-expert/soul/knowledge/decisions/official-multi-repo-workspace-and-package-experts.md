---
type: Decision
title: Official OAS development uses a multi-repository workspace with one expert soul per package
status: accepted
description: The official framework and package repositories live beneath one non-repository OAS team scope, and every official package repository owns a durable expert soul responsible for its vision, maintenance, implementation, and support.
tags: [architecture, workspace, packages, agents, ownership, development]
timestamp: 2026-07-26
---

**Status: accepted by the founder 2026-07-26.** This is the portable topology
for developing the OAS framework and its official packages after the
[distribution-package migration](/decisions/distribution-packages-config-profiles-and-requirements.md)
finishes. Concrete machine paths, account state, and migration timing remain
local deployment state rather than soul knowledge.

# Decision

## One non-repository team scope

The official development deployment uses a non-Git workspace directory as its
team boundary. Its children are independent Git repositories:

```text
<oas-workspace>/                 # not a Git repository
  oas-config.yaml                # team-wide deployment policy
  oas-lock.json                  # shared package closure where appropriate
  oas/                           # framework/kernel/Desktop repository
  oas-okf/                       # official package repository
  oas-aweb/
  oas-jira/
  oas-linear/
  oas-authoring/
  oas-dev/                       # OAS development profile + oas.review
```

The workspace config is obtained by explicitly adopting the default profile
from the `oas.dev` package at the non-repository root. The resulting
`oas-config.yaml` is an editable local snapshot, not live package policy; a
package update cannot rewrite it. `oas install` then restores the profile's
locked dependency closure and reconciles nested repository locks.

The `oas.dev` package is an OAS-project development package rather than part of
default OAS init. It ships the development config profile and the
`oas.review` capability, because that review discipline belongs to how the OAS
repositories are built and maintained rather than to every OAS installation.
It depends on the reusable OKF, aweb, and authoring packages selected by the
profile instead of copying them; Jira/Linear remain adopter-selected task
providers. The default profile preserves the established
`team.name: oas-framework` identity so moving to a non-Git workspace changes
the filesystem/config boundary, not the team, but ships no provider `team.id`,
account, credential, machine path, or literal placeholder. It declares
`framework-authors`, `developers`, and `package-maintainers`: authoring targets
framework authors and package maintainers, while review targets developers and
package maintainers.

The workspace config owns what every official-development agent should share:
team identity, common agent types, fundamental layer choices, shared authoring
and review capabilities, work-mode defaults, and package-profile defaults.
Each child repository may carry a closer `oas-config.yaml` for repository-only
settings, exclusions, instructions, or package-development needs.

This makes the official workspace exercise the same architecture offered to
other multi-repository teams. Running bare `oas install` at the team boundary
reconciles the shared closure and each nested repository's additional locks;
`oas status --team`, cross-repository spawn, messaging, and Desktop use the
same boundary.

The workspace root is deployment policy, not reusable product source. It is
not committed into one child repo and does not make machine/account state part
of a portable soul.

## One durable expert soul per official package

Every official package repository commits one package-specific expert soul.
The soul is the first-class owner of that package and combines four
responsibilities:

1. **Expert outlook** — preserve what the package is for, its layer or additive
   role, design constraints, provider-neutral contract, and roadmap.
2. **Maintenance** — own dependency health, compatibility floors, security,
   release readiness, consumer probes, and support diagnosis.
3. **Implementation** — develop and test package behavior in worktree mode,
   using review and PR gates rather than serving only as an advisory persona.
4. **Continuity** — accumulate package architecture, provider details,
   decisions, lessons, and playbooks in its soul so future instances begin as
   specialists.

Recommended unambiguous soul names follow the repository identity, for example
`oas-okf-expert`, `oas-aweb-expert`, and `oas-dev-expert`. Each soul belongs to a common
`package-maintainers` agent type declared at workspace scope, while its
canonical role and package-specific knowledge live in its own repository.

A package expert can spawn implementation helpers or reviewers when work
benefits from decomposition, but ownership stays with the package expert. The
framework `oas-expert` remains the cross-package architecture and official
release/PR gate: package experts own their repositories; the framework expert
keeps package contracts coherent across repositories.

## Common policy, local specialization

The workspace config can assign common capabilities to the
`package-maintainers` family — knowledge, messaging, authoring, review, and
other organization-wide protocols. Repository config and the package expert's
soul provide the narrower curriculum.

This uses the accepted [strict instance curriculum](/decisions/strict-instance-curriculum.md):
an instantiated package expert sees baseline OAS skills, its soul-private
package curriculum, and only capabilities assigned by the workspace/repository
config. It does not inherit every skill from every sibling package.

Package repositories may ship capabilities for users without automatically
activating those same capabilities in their maintainer soul. Distribution and
local assignment remain separate.

## Desktop as the workspace view

Opening the non-repository team scope in OAS Desktop gives one operator view
across framework and package repositories. Explicit instance relations make
coordinator, package-expert, helper, reviewer, and maintainer clusters visible;
workspace switching, specialist context, and attached terminals remain tied to
the repositories that own them.

This topology is the practical complement to the [Desktop situational-awareness
story](/decisions/provider-agnostic-specialization-and-curated-context.md): the
workspace creates one coherent team without collapsing independent repositories
or specialist ownership.

# Migration gate

The local workspace move happens only after the initial package architecture
and official-package transfers reach terminal outcomes. Before moving an
existing checkout:

- all active instances and package staging work finish or are retired safely;
- no required branch, worktree, notes, or unpushed commit is stranded;
- every repository has a clean, recoverable remote state;
- the `oas.dev` profile is adopted as a local snapshot and its generated config
  plus package lock are prepared and validated;
- absolute-path consumers, Desktop recents, and local tooling are inventoried;
- child repo configs and souls use portable repo-relative declarations where
  possible; and
- post-move `oas install`, doctor, team status, spawn/retire probes, and Desktop
  workspace checks pass.

The filesystem migration is an operator action with a rollback plan, not a
side effect of package installation or a task for an in-flight development
agent.

# Consequences

- The framework and official packages release independently while behaving as
  one OAS development team.
- Each package gains a durable owner that can both reason about and implement
  it; expertise does not remain centralized in the kernel repository.
- Team-wide config demonstrates package profiles, nested overrides, recursive
  reconciliation, strict curricula, cross-repo discovery, and Desktop at real
  scale.
- Cross-package architecture still has one stewardship gate, avoiding six
  isolated package directions.
- Local workspace setup becomes more deliberate: path migration and root
  config are operational state and wait until active work is safely complete.
