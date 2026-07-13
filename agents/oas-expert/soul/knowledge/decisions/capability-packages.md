---
type: Decision
title: Capability packages and instance-local composition
description: OAS distributes reusable agent capabilities as targetable packages while retaining formally defined, exclusive knowledge, messaging, and tasks layers.
tags: [architecture, capabilities, packages, integrations, config, skills, security]
timestamp: 2026-07-11
---

**Status: decided 2026-07-11 by the founder; clean-contract amendment approved
2026-07-11.** This decision establishes the first public capability-package
contract. It generalizes the package model in [kernel and
providers](/decisions/kernel-and-providers.md) and replaces the ambient
skill-scoping and soul-mutating injection behavior in
[oas-config](/architecture/oas-config.md). OAS had no external users when this
contract was established, so the pre-release integration shape carries no
compatibility promise and is removed rather than translated.

# Context

OAS integrations already bundle skills, instructions, requirements, lifecycle
hooks, and commands, but they are restricted to one fundamental layer. Their
skills can also become visible through runtime-specific ancestor or workspace
discovery, while configuration-selected instructions are written into a
committed soul. That makes it difficult to share a non-layer capability among
several souls, to know the exact runtime surface of one instance, or to keep a
portable soul independent from a particular laptop or workspace.

The desired model is package-like and harness-agnostic: acquire reusable
capabilities from bundled, local, or external sources; activate each capability
only for intended souls; and compose the exact runtime surface inside each
spawned instance.

This generalization does **not** remove OAS's fundamental layers. OAS continues
to define knowledge, messaging, and tasks formally as distinct framework
contracts. A concrete integration is the capability package selected to
satisfy exactly one of those exclusive slots. Other capability packages are
additive and do not claim a fundamental layer.

# Decision

## Structural units

A **capability package** is a distributable bundle. Its namespaced manifest ID
uses the `capability` field and may declare:

- identity, exact package version, OAS compatibility, and description;
- skills and optional instruction injections;
- external requirements;
- namespaced operational CLI commands; and
- only the approved lifecycle hooks: `soul-scaffold`, `spawn`, and `retire`.

A package may declare that it implements one of the formally defined
fundamental layers (`knowledge`, `messaging`, or `tasks`), in which case it is
an **integration**. It may implement at most one layer. For each target soul,
zero or one package may be selected for each layer; two active integrations
for the same layer are an error. General capabilities declare no layer and
compose additively.

Package manifests describe contents and compatibility, never deployment
targets. **Targeting is config-owned.** Soul-private instructions and skills
that are neither shared nor distributed remain part of the soul itself.

## Acquisition, locking, activation

Acquisition and activation are separate operations:

1. **Acquisition** resolves or downloads a declared package and records it.
   External packages are pinned in the OAS lockfile by source, exact version or
   commit, and integrity. Resolution never silently advances a lock.
2. **Activation** is a config binding from that acquired package to target
   souls, optionally with settings or a fundamental-layer selection.

`oas init` resolves declarations against the lockfile; it does not activate
every package merely because the package is installed or available. Package
management commands remain globally available so packages can be installed,
locked, trusted, inspected, upgraded explicitly, or removed even when they are
not active in the current agent context.

`capabilities` is the only declaration and activation map. A package's
manifest-declared `layer` determines whether activation fills a fundamental
slot; config never repeats a provider selection. `layers` exists only for the
explicit inherited-layer disable form `layers.<layer>: none`. Pre-release
`integrations`, `providers`, provider-valued `layers`, and workspace-config
spellings are rejected rather than translated.

## Config-owned targets and composition

V1 targets **souls**, never individual instances. Config can define explicit
named soul groups as lists of soul names. Tags and selector expressions are
left for a later version.

A binding targets one of:

- `global`: every soul governed by the config level that declares it;
- a named group defined by config; or
- one named soul.

“Global” is scope-local, not machine-universal by implication: laptop global
governs souls under that laptop config, workspace global governs souls under
that workspace, and repository global governs souls in that repository.

For a soul, all applicable global, matching-group, and soul bindings compose.
Settings use specificity `soul > group > global`; within one specificity,
closer config scope wins over an outer scope. Conflicting values at the same
specificity and config scope are ambiguous and fail with provenance rather
than depending on declaration order. Identical values are harmless.

An explicit `enabled: false` exclusion participates in the same precedence, so
a group can exclude a globally enabled capability and a soul-specific binding
can make the final explicit choice. Layer selection follows the same target
resolution and then enforces the one-provider-per-layer invariant.

## Exact instance-local runtime surface

A runtime session reads OAS-managed skills only from the instance's canonical
`.agents/skills/`. This rule is the same for pi, Claude, and other harnesses.
The only exception is the minimal `oas-getting-started` bootstrap needed before
a workspace or instance exists. Runtime adapters must not add ambient package,
config-level, workspace, or ancestor skill discovery.

At spawn, the kernel resolves soul-private skills plus all active capability
skills, detects duplicate skill names, and materializes the exact result into
the instance. Duplicate names are errors unless config explicitly names the
overriding source. The resolved capability IDs, origins, settings, and skill
set are recorded in `instance.json` for inspection and reproducibility.

The kernel also generates the instance's `AGENTS.md` from:

1. the canonical soul `AGENTS.md` content; then
2. deterministic, source-marked instruction blocks from active capabilities
   and kernel-owned context such as work mode.

Config-dependent composition never mutates the committed soul. The canonical
soul keeps `CLAUDE.md` as a symlink to `AGENTS.md`; the generated instance does
the same, preserving one canonical instruction file rather than maintaining
divergent copies. `oas doctor` exposes the final composed instructions and
their provenance because semantic conflicts between prose blocks cannot be
reliably inferred by the kernel.

## Commands, hooks, ownership, and trust

Operational commands use a package namespace and resolve only when their
package is active for the current soul/instance context. Package management
commands are exempt because they operate on acquisition and trust, not an
agent's activated runtime capability set. Duplicate package IDs or command
namespaces are errors.

Executable commands and lifecycle hooks from an external package do not run
until the user explicitly approves trust for the locked package identity and
integrity. Changing the resolved artifact invalidates that approval. Packages
containing only declarative skills/instructions are lower risk and do not need
executable trust, but they are still locked and integrity-checked because they
can influence agent behavior. External requirements are reported before use
and remain package-owned declarations, not implicit installers.

Hooks receive the existing structured OAS environment/JSON context. Ordering
is deterministic and independent of YAML or filesystem enumeration: increasing
config scope, then namespaced capability ID for `soul-scaffold` and `spawn`;
`retire` reverses the successful spawn order for cleanup. Failures are surfaced
with package provenance and recorded in lifecycle metadata.

Files created during soul scaffolding carry package ownership metadata. A
package cannot overwrite a soul-owned file or another package's file unless an
explicit compatible ownership/override rule authorizes it; otherwise scaffold
fails with a conflict. This protects canonical `AGENTS.md`/`CLAUDE.md` and OKF
conventions from being weakened by package composition.

# Consequences

- Integrations become a constrained kind of capability package rather than the
  universal extension unit, while fundamental layers remain first-class and
  formally exclusive.
- Shared capabilities can target all souls, explicit soul groups, or one soul
  without copying declarations into every soul.
- Every spawned instance has an auditable, harness-neutral skill and
  instruction surface; this removes skill pollution at the cost of spawn-time
  materialization and stricter collision errors.
- Portable souls remain canonical and deployment-independent. Instance files
  become generated views and must not be edited as the source of truth.
- Reproducibility and executable-package safety require a lockfile, integrity
  checks, explicit trust, and deliberate updates, adding package-management
  ceremony.
- V1 deliberately omits tags/selectors and per-instance targeting. Explicit
  groups and soul targets are less dynamic but easier to reason about.
- There is no migration surface for the unpublished integration prototype:
  one manifest identity, one discovery layout, one config activation path,
  and one resolver API make the first public contract smaller and testable.

# Options considered

1. **Keep integrations layer-only and retain ambient discovery.** Rejected:
   non-layer capabilities remain ad hoc and runtime visibility stays polluted.
2. **Rename integrations to soul work modes.** Rejected: OAS already uses work
   mode for checkout/worktree/attached lifecycle topology, and packages are not
   modes.
3. **Make all packages additive and remove formal layer slots.** Rejected: the
   knowledge, messaging, and tasks contracts are part of the OAS pattern, and
   competing providers for one slot must remain explicit and exclusive.
4. **Let packages select their own targets.** Rejected: package reuse would
   carry deployment policy, violating scope ownership and soul portability.
5. **Materialize at config level and rely on harness discovery.** Rejected:
   visibility would differ by harness and unrelated souls could see the skills.
