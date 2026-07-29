---
type: Decision
title: Packages materialize capabilities while config templates remain explicitly adopted local policy
status: accepted
description: Distribution packages are temporary transport and atomic update units; their capabilities materialize under .agents/capabilities/installed, while optional config templates use config-templates/, produce one locally owned oas-config.yaml per scope, and synchronize only through an explicit guided three-way operation.
tags: [architecture, packages, capabilities, config, templates, install, sync, storage]
timestamp: 2026-07-29
---

**Status: accepted by the founder 2026-07-29.** This decision supersedes the
installed-package-root and `configs:` portions of [Distribution packages,
config profiles, and consented host requirements](/decisions/distribution-packages-config-profiles-and-requirements.md).
It preserves package-level source/dependency/integrity/update transactions,
capability-level activation and trust, scoped config precedence, and explicit
host/runtime consent.

# Decision

## Package is transport; capability is the installed entity

An OAS distribution package is the source, dependency, integrity, review, and
atomic update unit. Acquisition stages a package in a temporary transaction
directory, validates the whole selected payload, materializes its declared
capabilities, writes the exact lock, and discards staging. A package root is not
the persistent user-facing installation.

A capability is the versioned installed and runtime-composed entity. Every
package must export at least one capability. A package may export several;
each remains independently targetable, activatable, configurable, excludable,
and trusted. Optional config templates are package source material, not
installed behavior.

The durable scope layout is:

```text
<scope>/
  oas-config.yaml                              # zero or one active config
  oas-lock.json                                # committed/restorable provenance
  .agents/
    capabilities/
      owned/<capability-id>/                    # authored source; normally committed
      installed/<capability-id>/                # generated installed artifact; ignored
    config-templates/
      adopted/<package-id>/<template-name>/
        oas-config.yaml                         # exact adopted base; commit-safe
        adoption.json                           # source/version/commit/path/hash metadata
```

There is no persistent `.agents/packages/installed/` in the final model. A
package checkout may exist only in transaction staging. Installed capability
artifacts carry generated package provenance (for example
`.oas-installation.json`) and the lock remains authoritative.

At every Git-backed scope, OAS ensures
`.agents/capabilities/.gitignore` ignores `installed/`; generated installed
capabilities must never enter commits. It must not ignore `owned/` or
`.agents/config-templates/adopted/`: authored capabilities and portable adopted
bases are intentionally reviewable/committable. Non-Git scopes use the same
layout without pretending Git owns their durability.

## Materialized capabilities are self-contained

For a new-format package, every capability entry names a dedicated capability
root. The installed artifact is the complete validated capability root,
including its `oas.json`, skills, injections, commands, hooks,
capability-defined agents, and any capability-local production closure.
Declared paths and symlinks must remain inside that capability root after
resolution. This tighter boundary makes each installed directory independently
hashable, inspectable, restorable, and trustable.

New packages use conventional roots such as
`capabilities/<capability-slug>/`; authoring tools do not emit `.` capability
roots. Compatibility readers may consume already-published packages whose
capability root is `.`, but migration must project only a self-contained
capability artifact and must fail rather than silently retain package-only
paths that cannot be represented safely.

Two packages at one scope may not install the same capability ID. Scope
precedence, `from: installed`, `from: owned`, and `from: path:<dir>` remain.
`from: installed` means the flat installed-capability store regardless of which
package supplied it.

## Lock package provenance and installed capability identity separately

The next lock format records both levels:

```json
{
  "lockfileVersion": 3,
  "packages": {
    "example.engineering": {
      "source": "git:https://example.invalid/engineering.git@v3.0.0",
      "version": "3.0.0",
      "commit": "0123456789abcdef",
      "path": "oas-package",
      "integrity": "sha256-…",
      "dependencies": []
    }
  },
  "capabilities": {
    "example.review": {
      "version": "2.1.0",
      "package": "example.engineering",
      "path": "capabilities/example-review",
      "integrity": "sha256-…",
      "trusted": false
    }
  }
}
```

Package integrity proves the exact distribution payload and dependency graph;
capability integrity proves the materialized installed bytes. Trust binds to
the capability integrity, never merely to official package identity. Updating
one package stages and verifies all its new exports, atomically replaces the
affected capability directories and lock entries, removes exports that no
longer exist only when config/dependents permit it, and invalidates trust for
changed executable surfaces.

Bare restore fetches the exact locked package source, verifies package
integrity, re-materializes missing capability artifacts, verifies their
individual integrity, and never advances source/version/commit.

## Config templates are optional and never applied by package installation

Package repositories name the source directory `config-templates/`, not
`configs/`. The package manifest names the resource `configTemplates`, for
example:

```json
{
  "package": "example.engineering",
  "capabilities": ["capabilities/example-review"],
  "configTemplates": {
    "default": {
      "path": "config-templates/default/oas-config.yaml",
      "default": true
    }
  }
}
```

New authoring emits only `configTemplates`. Readers temporarily accept the
published legacy `configs` spelling so immutable 0.19 package tags remain
consumable and migratable.

`oas install <package>` installs every exported capability but applies no
config template. It reports available templates as optional follow-ups. A
package with templates can therefore be used only for its capabilities.
Packages must export at least one capability; config-only and empty packages
are rejected in the new format.

## Exactly one active config and one adopted base per scope

A laptop, workspace root, or repository root has at most one active
`oas-config.yaml`. Different nested scopes may each have one and compose
through the existing outer-to-inner cascade. Package installation never creates
additional active configs at a scope.

First adoption is explicit:

```bash
oas init --package example.engineering --config default
```

It writes the one local `oas-config.yaml` and records the exact package template
as a visible, commit-safe base under `.agents/config-templates/adopted/`.
Templates must remain portable and contain no secret, credential, account,
machine path, or provider-local ID. The active config is immediately ordinary
local policy: hand edits and `oas use`/`oas type`/injection overrides remain
authoritative, and package updates never rewrite it. Product documentation,
README onboarding, CLI output, and authoring guidance must call these resources
**templates**, never installed policy or package-controlled config, and must
state plainly that adopters may change every copied setting as they wish.

One scope has at most one current adopted base template. Other installed
packages may advertise templates, but none becomes another active config. A
user may switch bases only through an explicit guided adoption/rebase.

## Synchronization is explicit, guided, and atomic

Updating a package makes a newer template available without touching local
policy:

```bash
oas update example.engineering
oas config diff
oas config sync
```

`oas config sync` performs a three-way comparison:

1. the recorded adopted base;
2. the current local `oas-config.yaml`; and
3. the selected template from the currently locked package.

Upstream-only changes may be offered for application; local-only changes remain
local; overlapping changes are conflicts requiring an explicit local/package/edit
choice. The command presents the complete plan before mutation, supports stable
JSON, refuses noninteractive ambiguity, writes atomically, updates the adopted
base only after success, and preserves a recoverable backup.

`oas config sync --reset` is the explicit exact-template replacement path. It
previews all lost local changes, requires strong confirmation (or an explicit
noninteractive acceptance flag), backs up the current config, and atomically
replaces both config and adopted-base metadata.

Switching to another package/template uses an explicit guided command such as:

```bash
oas config adopt other.package --config default
```

It rebases the one local config against the new base rather than installing a
second config.

## Migration and compatibility

The kernel continues to read:

- valid v1 capability locks and `.agents/capabilities/installed/` artifacts;
- valid v2 package locks and `.agents/packages/installed/` roots; and
- immutable package manifests using `configs` or a `.` capability root.

Migration is explicit and transactional:

- v1 artifacts gain package provenance only when a catalog mapping exists;
- v2 installed package roots are projected into flat installed capability
  artifacts using their already-locked bytes when possible, avoiding network;
- v3 is written only after every capability and adopted-template base is valid;
- old stores are removed only after the new lock and artifacts are durable;
- custom owned/path capabilities are unchanged; and
- executable trust is never broadened during migration.

A failed conversion leaves the prior lock and store byte-identical. Doctor
reports the exact migration state and command.

# Consequences

- Users inspect installed behavior where Agent Skills conventions lead them:
  `.agents/capabilities/installed/`.
- Package provenance and atomic updates remain exact without treating config
  templates as installed policy.
- The one-config-per-scope rule stays obvious and compatible with config
  cascading.
- Guided template synchronization becomes safe because the original base is
  visible and portable.
- The change is a storage/lock contract transition and requires a compatibility
  release, official package revisions, migration gates, fresh onboarding
  updates, and documentation changes before publication.
