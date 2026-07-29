---
type: Decision
title: Distribution packages, config profiles, and consented host requirements
status: accepted
description: A package layer above capabilities — one locked Git package may provide several capabilities and snapshot config profiles, while scoped config keeps targeting and overrides and missing host CLIs install only with separate informed consent.
tags: [architecture, packages, capabilities, config, install, trust, requirements, workspace]
timestamp: 2026-07-26
---

**Status: accepted by the founder 2026-07-26.** Its package-store and config-profile resource details are superseded by [Packages materialize capabilities while config templates remain explicitly adopted local policy](/decisions/capability-materialization-and-config-template-sync.md), accepted 2026-07-29. The package source/integrity/update unit, independently targetable capabilities, config sovereignty, and consented-requirement principles remain binding. This decision
amends [capability packages](/decisions/capability-packages.md), the [scoped
capability store](/decisions/scoped-capability-store-and-templates.md), and the
[marketplace transition](/decisions/marketplace-workmodes-runtime.md). It keeps
the target resolution, layer exclusivity, generated-instance composition, and
[injection override](/decisions/config-authorship-and-ambient-skills.md)
contracts unchanged.

# Context

OAS currently uses “capability package” for both the distributable artifact and
the one activation unit inside it. One acquired directory has one root
`oas.json`, one capability ID, one capability lock entry, and optionally one
config template obtained independently from a local file or another Git repo.
The official marketplace is an interim directory bundled in the kernel.

The desired distribution model is closer to Pi packages: a Git repository is
the install/update/review unit and may carry multiple resources. For OAS those
resources are one or more independently targetable capabilities plus one or
more reference configurations. A team package should be able to ship a default
workspace profile that declares agent families and assigns capabilities to
those families, while an adopter receives an ordinary local `oas-config.yaml`
that can be edited and overridden by closer repository configs. One restore at
the workspace root should also reconcile package dependencies declared by
nested repositories.

Several capabilities additionally depend on host CLIs. Today `requires`
reports a missing command and an installation URL; it deliberately does not
install anything. A useful setup flow should offer to install a missing tool,
but downloading or executing a host installer is a different trust decision
from downloading an instruction bundle and must never happen silently.

Pi supplies useful prior art without being copied blindly:

- one package source may expose several resource kinds;
- user and project scopes are separate, and the project entry wins for the same
  package identity;
- npm, Git, and local sources have normalized identities;
- missing project packages are installed only after project trust;
- package resources can be filtered without mutating package source; and
- Git checkouts and npm dependencies are materialized into managed stores.

OAS has stricter requirements Pi does not solve for it: capability targeting,
exclusive fundamental layers, exact lock integrity, executable approval,
config snapshots, nested repository scopes, and deterministic instance-local
composition.

# Decision

## 1. Separate the distribution unit from the activation unit

Introduce an **OAS distribution package** above capabilities:

- A **package** is the source, acquisition, dependency, update, integrity, and
  review unit. In v1 it is normally one Git repository; local paths are also
  supported for development.
- A **capability** remains the targeting and runtime-composition unit. It still
  has one `oas.json`, may implement at most one fundamental layer, and is
  activated independently through `oas-config.yaml`.
- A **config profile** is a package resource containing a complete reference
  `oas-config.yaml`. Applying one creates a local snapshot; it is not ambient
  policy and not live inheritance.

This resolves the overloaded current term. Documentation may say “capability”
for the inner unit, but “package” without qualification means the outer
distribution unit.

A package root carries an explicit `oas-package.json`:

```json
{
  "package": "example.engineering",
  "version": "1.0.0",
  "description": "Shared agent capabilities and workspace defaults.",
  "compatibility": { "oas": ">=0.19.0" },
  "capabilities": [
    "capabilities/example-review",
    "capabilities/example-delivery"
  ],
  "configs": {
    "default": {
      "path": "configs/default/oas-config.yaml",
      "description": "Recommended workspace setup",
      "default": true
    },
    "minimal": {
      "path": "configs/minimal/oas-config.yaml",
      "description": "Knowledge only"
    }
  },
  "dependencies": [
    "oas.okf@v1.4.0",
    "oas.aweb@v1.5.1"
  ]
}
```

The manifest explicitly enumerates resources. Conventional directories may be
used by authoring tools, but install does not ambiently load arbitrary files.
Every path is package-relative, must remain inside the locked package after
symlink resolution, and must identify the expected resource kind. Capability
IDs and package IDs are separately namespaced and unique at one scope.

Package dependencies are package source specifications, not capability IDs.
The first implementation does not need a general semver solver: a dependency
uses an official package selector, a pinned Git tag/commit, or a local path;
the resulting full graph is exact-locked. Cycles and two sources claiming the
same package identity at one scope are errors with provenance.

Capability manifests still cannot contain `global`, `agent-types`, `souls`, or
other deployment targets. A config profile may contain them because it is
config source material, not reusable capability behavior. This preserves the
boundary in [deployment config over package forks](/decisions/workspace-configs-over-subpackages.md).

## 2. Lock and store whole packages; discover capabilities through them

Installed package roots live beside the owning config and lock:

```text
<scope>/.agents/packages/installed/<package-slug>/
<scope>/oas-lock.json
```

`oas-lock.json` v2 records packages rather than pretending every capability is
a separate artifact:

```json
{
  "lockfileVersion": 2,
  "packages": {
    "example.engineering": {
      "source": "git:https://example.invalid/engineering-oas.git@v1.0.0",
      "version": "1.0.0",
      "commit": "0123456789abcdef",
      "integrity": "sha256-…",
      "capabilities": ["example.review", "example.delivery"],
      "dependencies": ["oas.okf", "oas.aweb"],
      "trustedCapabilities": []
    }
  }
}
```

The capability list is verification metadata, not a second declaration. It
must match the locked package manifest on restore. Discovery indexes the
`oas.json` files enumerated by every visible package and gives each capability
package/source provenance.

Existing authored capabilities remain under
`.agents/capabilities/owned/<id>/`, and `from: path:<dir>` remains the direct
capability-development escape hatch. Installed capability directories are
replaced by installed package roots. Config keeps `from: installed`, so
activation files, targeting, settings, exclusions, skill overrides, and
injection overrides do not acquire a package-shaped syntax.

Within a config chain:

- a closer scope may supply a different version of the same package;
- two packages at the same scope exporting one capability ID are an error;
- a closer capability origin follows the existing scope precedence;
- owned/path capabilities retain their current structural trust rules; and
- installed package contents never become active merely because they are
  present.

Package source forms follow Pi’s understandable grammar where practical:
`git:host/org/repo@ref`, raw HTTPS/SSH Git URLs, and local paths. An unpinned
Git source resolves once and locks the exact commit; it never advances during
restore. Official short IDs resolve through an OAS package catalog to Git
repositories in the OAS organization. The catalog authenticates identity and
discovery; it does not silently update a lock or grant executable trust.
Registry/npm sources can be added later without changing the package/resource
split.

## 3. Keep acquisition, config adoption, activation, and host setup distinct

There are four deliberate actions:

1. **Acquire**: `oas install <package-source>` fetches and exact-locks the
   package closure. Nothing is activated and no config is applied.
2. **Adopt a profile**: `oas init --package <package-source> [--config <name>]`
   previews and snapshots one package profile as the target scope’s
   `oas-config.yaml`, records package/profile/commit provenance, and creates the
   package lock graph. It refuses to overwrite an existing config. A marked
   default removes the need for `--config`; multiple unmarked profiles require
   a choice.
3. **Activate/override**: the snapshot is an ordinary scoped config. `oas use`,
   `oas type`, `oas inject eject`, and hand edits keep their current meaning.
   Package updates never rewrite the snapshot.
4. **Provision host requirements**: after packages and config resolve, OAS
   reports missing commands for active capabilities and, only with informed
   user consent, runs an applicable installer recipe.

`oas init --template` remains useful for a bare config file. Package profiles
are the preferred route when the config and its capability providers travel
together. A later `oas config diff --package <id> --config <name>` should show
how the local snapshot differs from the package’s current profile; it must not
merge or overwrite automatically.

A profile is validated before adoption:

- it is valid against the current OAS config schema;
- every referenced installed capability is provided by the package dependency
  closure;
- referenced layers agree with capability manifests;
- all declared agent types are syntactically valid; and
- paths do not escape the eventual target scope.

The profile may declare agent types and target them. Souls still opt into one
family through `type:` in `soul.yaml`; a package profile cannot reclassify a
soul. Package profiles must remain generic and must not embed secrets, personal
accounts, host paths, or credentials.

## 4. Preserve scoped override semantics

The copied profile does not introduce another config tier. It occupies the
scope where the user ran `oas init --package`:

```text
laptop config       outer defaults
workspace profile   copied package defaults and team boundary
repository config   closer repository-specific overrides
```

All existing semantics remain: soul > agent type > global specificity, then
closer config scope; explicit false exclusions; `none` for inherited layers;
`from:` enforcement; and installed-capability injection ejection. The package
is never consulted during spawn for targeting policy after the profile has
been copied. This is what lets a developer edit local workspace defaults and a
repository override them without forking the package.

Every capability exported by an installed package remains individually
addressable by capability ID in local config. The adopter may activate a
capability omitted by the package profile, disable one the profile enabled,
retarget it from global to an agent type or soul, give different families
different settings, or replace an exclusive-layer provider. A package cannot
mark one of its capabilities mandatory or reserve its original target. The
profile is only the package author's recommended starting policy; the resolved
local config is always authoritative.

## 5. Make bare install a workspace reconciler at an explicit team boundary

The current bare `oas install` restores only locks in the current ancestor
chain. Extend it so running at a config scope that declares `team:` reconciles
the entire workspace:

1. restore that scope’s exact package graph;
2. discover descendant repository scopes containing `oas-config.yaml` or
   `oas-lock.json` inside the team boundary;
3. prune `.git`, generated package stores, dependency/vendor directories,
   agent instances/worktrees, and nested team boundaries;
4. restore each descendant scope’s package graph once in deterministic path
   order;
5. validate that every config-referenced installed capability is supplied by a
   visible locked package; and
6. aggregate missing requirements and failures by scope.

At a non-team scope, bare install keeps current-chain behavior. An explicit
`--recursive` may request descendant reconciliation outside a team boundary,
but the command must print the chosen boundary before doing network or host
work. It never scans downward from the laptop/home config by default.

This gives a clean checkout the intended flow:

```bash
oas install
# restores workspace packages, then packages needed only by nested repositories
```

The root package can supply shared capabilities once at workspace scope; a
nested repository lock exists only for additional or overriding packages.

## 6. Install external CLIs only through a separate consent gate

Evolve a capability requirement from a documentation-only URL into a
declarative, platform-aware requirement:

```json
{
  "command": "example-cli",
  "why": "send and receive team messages",
  "install": {
    "docs": "https://example.invalid/install",
    "methods": [
      {
        "platform": "darwin",
        "manager": "npm-global",
        "package": "@example/cli@1.2.3"
      }
    ]
  }
}
```

The initial safe method vocabulary is allowlisted and argument-structured
(`npm-global`, `brew`, and download-with-checksum when implemented). Recipes
are data, not shell snippets. OAS renders the exact command/source/version and
whether it changes user- or machine-level state before asking. It does not use
`sudo`, accept shell metacharacters, perform authentication, or run provider
onboarding as part of binary installation.

Consent and trust are intentionally separate:

- Package integrity approval authorizes only a capability’s OAS commands and
  lifecycle hooks.
- Requirement-install consent authorizes one displayed host installation
  action.
- Installing a binary does not authorize or activate the capability.
- Skipping leaves an actionable doctor warning and setup command.

Requirements are considered only for capabilities activated somewhere in the
reconciled scopes, not every capability included in a multi-capability
package. OAS deduplicates by required command, verifies the command on `PATH`
after installation, and reports which capabilities requested it. Interactive
`oas install` may prompt. Non-interactive runs never install host tools by
default; automation must name each accepted requirement explicitly, and a
`--no-requirements` mode supports CI/package-only restoration.

When no safe recipe matches the host, OAS prints the verified documentation
URL. Capability-specific authentication remains an explicit namespaced command
such as `oas <namespace> setup` after the CLI exists.

Package-provided arbitrary installer scripts are not part of the first
contract. If later required, they are executable package surfaces: they need
exact-integrity trust plus the separate per-run requirement consent prompt.

## 7. Bind executable trust to the capability inside the package

A multi-capability package should not make trust broader than today. The lock
binds approvals to package integrity but records the approved capability IDs:

- skill/instruction/config-only resources require valid lock integrity but no
  executable approval;
- `oas trust <capability>` approves only that capability’s commands/hooks in
  its provider package at the current package integrity;
- `oas trust <package> --all-capabilities` is an explicit bulk operation with a
  complete executable-surface summary; and
- any package integrity change invalidates all capability approvals.

Official catalog identity is not executable approval. This is stricter than
the interim kernel-bundled marketplace’s auto-trust and is necessary once
packages release independently.

A Git package may carry a checked-in `package-lock.json` for JavaScript runtime
dependencies. OAS may materialize those with `npm ci --ignore-scripts`; the
source integrity plus dependency lock and materialized dependency integrity
form the runtime closure shown by doctor. Arbitrary npm lifecycle scripts do
not run during acquisition. Packages that need a build must ship runnable
artifacts in v1; a future trusted build contract can be designed separately.

An independently released package must not import private kernel files, even
by discovering the installation root and dynamically importing `lib/core.mjs`.
Kernel services needed by package commands or hooks must cross a documented,
versioned package-runtime boundary: either a supported module export or a
structured CLI API chosen by the engine contract. The package declares the
compatibility floor for that boundary, and consumer tests pin it. Merely raising
an OAS version floor is not a substitute for making the used surface public.

## 8. Add complete package lifecycle commands and diagnosis

The package layer needs the same complete lifecycle users expect from Pi,
without Pi’s silent floating updates:

```text
oas install <source>                         acquire + lock, inactive
oas install                                  exact restore/reconcile
oas init --package <source> [--config name] adopt a profile snapshot
oas list                                     packages, capabilities, profiles, scopes
oas update <package>                         explicit re-resolve + diff + trust reset
oas remove <package>                         refuse while config/dependents need it
oas trust <capability>                       approve that executable surface
oas doctor                                   package graph, providers, profile provenance,
                                             integrity/trust, missing requirements
```

Update is transactional: fetch to a temporary location, validate the complete
manifest/config/capability closure, show capability/profile/executable changes,
then replace artifact and lock together. Config snapshots remain untouched.
Remove explains dependent packages and config references rather than leaving a
broken deployment.

Doctor must distinguish package failures from capability failures: missing
locked package, package integrity drift, manifest graph error, missing exported
capability, capability provenance mismatch, untrusted executable surface,
missing host command, and available-but-unapplied profile.

# Official package migration

After the kernel contract is accepted and tested, move every official
capability out of the kernel repository into a self-contained public Git
repository in the OAS GitHub organization. The initial set is the current OKF,
aweb, Jira, Linear, review, and authoring capabilities. Each repository gets:

- `oas-package.json` and its existing capability `oas.json`;
- self-contained skills/injections/agents/commands — no `../../` references
  into the kernel repository and no private-kernel module imports;
- package schema and capability schema validation;
- unit tests plus a clean acquire → lock → trust-if-needed → activate → spawn
  probe against its declared OAS compatibility floor;
- release tags and immutable checksums/provenance; and
- a catalog entry after its release passes the consumer probe.

The authoring skills move to the authoring package as their single canonical
home; they are not copied into both repositories. The framework workspace then
acquires and activates that package like any other deployment that needs those
skills.

The kernel stops shipping the capability source trees and instead ships only
the package catalog/bootstrap metadata needed to locate official repositories.
The bootstrap/default init experience resolves official package IDs through
that catalog and exact-locks their Git release.

Migration should be staged:

1. land package engine + lock v2 + diagnostics while the existing marketplace
   remains readable for migration;
2. publish and probe each official package repository;
3. switch default init/catalog resolution to those repositories;
4. provide an explicit lock migration command that maps old one-capability
   marketplace locks to package locks and preserves config activation;
5. remove the bundled marketplace only after the published-artifact and clean
   workspace probes pass.

During the staged interval, an explicitly migrated v2 lock may retain a
read-only `capabilities` residue for v1 entries whose official package is not
yet catalog-mappable. Only the migration command may create that mixed
migration envelope; normal install/update cannot add legacy entries. Conversion
is transactional, exact legacy integrity/trust semantics are preserved without
transferring trust to package entries, and a residue ID colliding with a
package-exported capability is an error rather than an implicit winner. Doctor
lists each residue with its migration action, and the final marketplace
cutover/deployment probe requires zero residue.

There is no permanent dual discovery contract. After the transition, residue
is readable only for pointed diagnosis/migration, never as a way to add legacy
capabilities. Old locks receive a pointed migration path rather than silently
resolving to a different remote artifact.

# Implementation workstreams after sign-off

The work decomposes into three coordinated deliveries after the schema is
frozen:

1. **Package engine and security** — package manifest/schema, source parsing,
   package store, lock v2/graph, capability indexing, runtime dependency
   containment, per-capability trust, lifecycle commands, and migration.
2. **Config bootstrap and workspace reconciliation** — package profile init and
   validation, provenance/diff UX, team-boundary recursive restore, nested
   scope reporting, requirement aggregation, consented installer methods, and
   doctor output.
3. **Official package extraction and publication** — create the official repos,
   make resources self-contained, add package CI/release probes, publish tags,
   seed the catalog, migrate defaults, and remove the interim bundled
   marketplace after parity gates.

Workstreams 1 and 2 may proceed in parallel only after agreeing on the package
manifest, lock v2, and resolver API. Workstream 3 can scaffold repositories in
parallel but cannot publish the final contract or catalog until the engine’s
consumer fixtures pass. Framework implementation, repository creation, and coordinator launch proceed
through the approved coordinator workstreams; the maintainer remains the PR
gate for every delivery.

# Consequences

- One installable/reviewable Git repository can ship one or many independently
  targetable capabilities and reference configs.
- Package configs can express agent-family assignments without putting targets
  in capability manifests or creating live package policy.
- Existing OAS config precedence and override UX remain the deployment policy
  mechanism.
- A workspace root can restore both shared and repository-specific package
  graphs in one command.
- External CLI setup becomes guided without becoming silent remote execution.
- Lock/trust state moves from capability artifacts to package artifacts while
  preserving least-privilege capability approvals.
- Official capabilities can release independently of the kernel, at the cost
  of catalog, compatibility, migration, and cross-repository release work.
- Snapshot configs deliberately drift from newer package defaults; diff is
  offered, automatic merge is not.

# Options considered

1. **Let a capability manifest list several capabilities.** Rejected: it keeps
   the distribution/activation concepts entangled and makes independent
   targeting and layer validation awkward.
2. **Let packages apply their config automatically at install.** Rejected:
   acquisition would mutate deployment policy and violate “acquired is not
   active.” Profile adoption must be explicit and previewable.
3. **Use live `extends:` links to package configs.** Rejected: package updates
   would change targets and settings at a distance. Snapshots preserve the
   existing no-silent-update rule.
4. **Copy each capability out of a package into the old installed store.**
   Rejected: it duplicates artifacts, loses one-package integrity/update
   semantics, and strands config profiles outside the lock unit.
5. **Trust every capability in an official package automatically.** Rejected:
   repository identity is not consent to independently updated executable
   code.
6. **Allow requirement install shell commands.** Rejected for v1: a URL or
   shell string is not a safe installer contract. Allowlisted structured
   methods plus an exact prompt are auditable.
7. **Recursively scan from every config by default.** Rejected: a laptop config
   could trigger an unbounded home-directory scan. Automatic descent is tied
   to an explicit team boundary.
8. **Put personal overrides in the package profile.** Rejected: profiles are
   shareable defaults. Personal/account/host state stays local and existing
   scoped config rules remain authoritative.

# Accepted sign-off

The founder approved the complete direction on 2026-07-26, including these
contract choices:

1. package and capability are distinct first-class units;
2. package config is an explicitly adopted snapshot, never live inheritance;
3. installed artifacts move to a package store and lockfile v2 locks packages;
4. bare install descends automatically only from an explicit `team:` boundary;
5. host CLI installation uses a separate per-requirement consent gate; and
6. official Git packages lose automatic executable trust and use
   per-capability approvals tied to exact package integrity.

The approval also confirmed adopter sovereignty over targeting: every
capability exported by an installed package stays independently configurable,
and no package profile can make a capability, family assignment, or setting
mandatory.

# Citations

1. [Pi Packages](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md) — package resources, source forms, user/project scopes, dependency installation, filtering, and deduplication.
