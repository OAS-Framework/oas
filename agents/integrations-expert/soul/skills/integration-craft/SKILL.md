---
name: integration-craft
description: >-
  Shared procedure for building OAS capability packages and fundamental-layer
  integrations: namespaced oas.json manifests, skills/instructions, external
  requirements, commands/hooks, acquisition/trust, targeting tests, and probe
  verification. Use before layer-specific authoring or when a package fails to
  resolve, activate, compose, or execute.
---

# Capability package and integration craft

A capability package distributes reusable agent behavior. An integration is a
package declaring exactly one exclusive `knowledge`, `messaging`, or `tasks`
layer. General packages omit `layer` and compose additively.

## Manifest

```json
{
  "capability": "vendor.team-chat",
  "command": "team-chat",
  "version": "1.0.0",
  "compatibility": { "oas": ">=0.6.2" },
  "description": "Messaging through Team Chat.",
  "layer": "messaging",
  "requires": [{ "command": "team-chat", "why": "send messages" }],
  "skills": ["skills"],
  "inject": "injects/team-chat.md",
  "commands": { "auth": "bin/team-chat.mjs auth" },
  "hooks": { "spawn": "bin/hook.mjs spawn", "retire": "bin/hook.mjs retire" }
}
```

- Namespace `capability` and optional CLI `command`; collisions are errors.
- Declare identity/version/compatibility/description truthfully.
- `layer` is absent or exactly one fundamental layer.
- Only `soul-scaffold`, `spawn`, and `retire` hooks are accepted.
- Declare every external command, but never install it implicitly.
- Never put global/group/soul targets in the manifest.

## Instructions and skills

Keep an injection short: name the capability/layer, tell agents which skill to
load, and state boundaries. It is composed into generated instance
`AGENTS.md`, not committed souls.

Skills must follow Agent Skills format and be independently useful. Spawn
materializes exact selected skills for both pi and Claude. Duplicate names
error unless config explicitly selects a source; do not rely on discovery
order.

## Distribution and security

1. Framework contribution: `capabilities/<name>/`.
2. Config-owned local package: `<level>/.agents/capabilities/<name>/`.
3. External package: own git repo, acquired with `oas install`.

External artifacts require source + exact version/commit + integrity in
`oas-lock.json`. Commands/hooks require `oas trust` for that integrity.
Skill/instruction-only packages still require lock integrity. Acquisition does
not activate; activation never silently downloads or updates.

Manifest-relative paths for locked external packages must be resolved through an
integrity-bound helper: the real target for skills, injections, hooks, and
commands must stay beneath the real package root. Reject paths or symlinks that
escape the artifact unless a bundled framework package has an explicit trusted
exception.

## Targeting belongs to config

```yaml
groups:
  developers: [backend, frontend]
capabilities:
  vendor.team-chat:
    groups:
      developers:
        enabled: true
        settings: {channel: engineering}
```

Test global, matching/non-matching groups, soul specificity, exclusions, and
equal-specificity conflict errors. For layer integrations test that a second
provider for the same target errors.

## Hooks and commands

Hooks receive `OAS_CAPABILITY`, `OAS_LAYER`, standard lifecycle/context vars,
`OAS_SETTINGS`, and prior `OAS_META`. Emit final JSON `{meta, brief, warning}`.
Design hooks idempotently and degrade external outages to clear warnings.
Scaffold hooks must not overwrite canonical or another package's files.

Operational commands run only when the package is active in current context or
instance. Package-management commands remain global. Test both allowed and
denied dispatch.

## Verification checklist

1. Resolve a temp config with `resolveOasConfig(repo, soulName)`; inspect
   capabilities, layer, provenance, settings, and trust.
2. Spawn pi and Claude scaffold-only probes. Both must contain the same exact
   `.agents/skills`. An unrelated ancestor skill must be absent. Use matching
   capability-aware kernel and pi adapter versions. The older adapter adds
   workspace and package roots even when materialization is correct.
3. Verify generated instance `AGENTS.md` contains canonical soul + selected
   blocks while soul `AGENTS.md` remains byte-identical; `CLAUDE.md` symlinks
   remain canonical.
4. Inspect `instance.json` capability, skill, instruction, hook, and trust
   records.
5. Test missing requirements, duplicate skill/ID/command errors, hook order and
   reverse retire, and scaffold ownership when relevant.
6. For external packages, test unlocked, untrusted executable, trusted exact
   integrity, tampered integrity paths, and manifest paths or symlinks that
   escape the locked artifact.
7. Run `oas doctor <repo> --soul <name>` and retire the probe.

Gotcha: `spawnInstance` takes the agent object returned by `findAgent`, not a
name string.

## Handoff

Leave explicit commands; do not activate without approval:

```bash
oas install <source> --dir <level>
oas trust <id> --dir <level>          # executable packages only
oas use <id> --group <group> --dir <level>
oas doctor <repo> --soul <name>
```
