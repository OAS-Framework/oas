# Capability packages

A **capability package** is OAS's reusable distribution unit. It can contribute
skills, instance instructions, requirements, namespaced commands, and approved
lifecycle hooks. Configuration—not the package—decides which souls receive it.

An **integration** is a capability package that implements one exclusive
fundamental layer: `knowledge`, `messaging`, or `tasks`. General capabilities
claim no layer and compose additively.

## Mental model

This is OAS's first public capability-package contract. The unpublished,
pre-release integration prototype has no compatibility promise: its manifest,
config, discovery, and command aliases are intentionally not accepted.

The contract is:

1. **Acquire** a package. External artifacts are pinned in `oas-lock.json`.
2. **Activate** it for global scope, a config-owned soul group, or one soul.
3. **Spawn** a soul. OAS resolves the target, creates the exact
   `.agents/skills/`, and generates that instance's `AGENTS.md` without
   changing the canonical soul.

Acquired does not mean active. `oas init` activates only the explicit defaults
it writes; it never enables every package merely because it is available.

## Manifest

A self-contained package has an `oas.json`:

```json
{
  "capability": "example.team-chat",
  "command": "team-chat",
  "version": "1.2.3",
  "compatibility": { "oas": ">=0.6.2" },
  "description": "Messaging through Team Chat.",
  "layer": "messaging",
  "requires": [
    { "command": "team-chat", "why": "send and receive messages" }
  ],
  "skills": ["skills"],
  "inject": "injects/team-chat.md",
  "commands": { "auth": "bin/team-chat.mjs auth" },
  "hooks": {
    "spawn": "bin/team-chat-hook.mjs spawn",
    "retire": "bin/team-chat-hook.mjs retire"
  }
}
```

- `capability` is a namespaced ID. Duplicate IDs are errors.
- `command` is an optional, unique CLI namespace. The example exposes
  `oas team-chat auth`.
- `layer` is optional and may name exactly one fundamental layer. Two active
  packages cannot implement the same layer for one soul.
- `skills` entries can be skill directories or roots containing skills.
- `inject` is optional instance instruction Markdown.
- Only `soul-scaffold`, `spawn`, and `retire` hooks are accepted.
- `requires` reports external tools; OAS does not install them silently.
- Target names never appear in a package manifest.

`capability` is the only manifest identity field. The machine-readable
contract is [`capability-manifest.schema.json`](capability-manifest.schema.json).

## Config and targets

```yaml
groups:
  developers: [api-expert, ui-expert]
  reviewers: [security-reviewer, release-reviewer]

capabilities:
  oas.okf:
    source: bundled
    global: true

  example.code-review:
    source: git:https://example.invalid/code-review.git
    groups:
      developers:
        enabled: true
        settings:
          depth: normal
    souls:
      security-reviewer:
        enabled: true
        settings:
          depth: exhaustive

  example.deploy:
    global: true
    groups:
      reviewers: false       # explicit exclusion
    souls:
      release-reviewer: true # more-specific re-enable

skill-overrides:
  review: example.code-review
```

`global` means all souls governed by the config level declaring it—not every
soul on the machine regardless of scope. Laptop, workspace, and repository
configs each govern souls beneath that level.

Composition is additive across matching global, group, and soul bindings.
Settings use `soul > group > global`, then closer config scope. Conflicting
values at equal specificity and scope are errors. `enabled: false` follows the
same precedence. V1 groups are explicit soul lists; tags and selectors are not
implemented, and bindings do not target individual instances.

`capabilities` is the only activation map. `layers` accepts only
`knowledge|messaging|tasks: none`, which explicitly suppresses an inherited
integration without naming a replacement.

## Exact runtime composition

Every spawned instance receives:

- canonical soul skills;
- the kernel `oas` skill; and
- skills from capabilities active for that soul.

OAS copies only those skill trees into real directories under
`<instance>/.agents/skills/` and records the names and source capability in
`instance.json`. `.claude/skills` points to
the same canonical directory. Pi launches with `--no-skills` plus this one
explicit directory, preventing user, project, and pi-package skill discovery.
Claude uses an instance-local `CLAUDE_CONFIG_DIR` pointing at the same set and
loads only that `user` setting source, excluding project/local customization sources.
`oas-getting-started` is the one ambient exception before a workspace exists.

Duplicate skill names fail spawn unless `skill-overrides` explicitly names the
winning source. Pi and Claude therefore receive the same OAS-managed set rather
than relying on different ancestor-discovery rules.

For pi, exact isolation needs the capability-aware versions of both
`@oas-framework/oas` and `@oas-framework/pi`. The kernel disables normal skill
discovery at launch. The changed adapter contributes only the instance-local
set instead of the older workspace and package roots. Install matching package
versions and upgrade them together.

The instance's `AGENTS.md` is a generated regular file containing:

1. the canonical soul `AGENTS.md`;
2. the kernel and work-mode blocks;
3. active capability blocks in deterministic order; and
4. unconditional config instruction blocks.

Its `CLAUDE.md` symlinks to `AGENTS.md`. The committed soul remains unchanged.
Edit the canonical soul, injection source, or config, then spawn a new
instance; do not edit generated blocks as source-of-truth changes.

Inspect a final composition:

```bash
oas doctor /path/to/repo --soul api-expert
oas doctor /path/to/repo --soul api-expert --json
```

Doctor reports active/acquired packages, target provenance, settings, skills,
hooks, trust, instruction sources, and final composed text. It cannot infer
semantic contradictions between two prose injections; review the output.

## Acquisition, lock, restore, and trust

```bash
oas install https://example.invalid/team-chat.git --dir /path/to/repo
oas install ../team-chat --dir /path/to/repo
oas install                       # bare: restore locked-but-missing artifacts
```

Every acquired artifact lands in the owning scope's
`.agents/capabilities/installed/`, beside the `oas-config.yaml` and
`oas-lock.json` that govern it. Install maintains a one-line
`.agents/capabilities/.gitignore` so acquired artifacts stay uncommitted, like
`node_modules`. A fresh clone with a committed config and lock runs bare
`oas install` to reacquire everything; each restored artifact must hash to the
locked integrity or the restore fails and removes the fetched copy.

Installation acquires and locks; it does **not** activate. `oas-lock.json`
records:

- source;
- exact package version and git commit when available; and
- SHA-256 integrity of the artifact.

OAS never pulls an existing package silently. Changed integrity blocks use
until the package is deliberately reacquired. For external packages containing
commands or hooks, approve that exact locked artifact:

```bash
oas trust example.team-chat --dir /path/to/repo
```

Changing integrity invalidates approval. Skill/instruction-only packages still
require a valid lock but do not require executable approval. Manifest paths in
external packages must remain inside the locked artifact (including after
symlink resolution), so approved hooks and commands cannot execute unhashed
files. The trust boundary is structural: anything under `installed/` must have
a matching lock entry, so an installed artifact cannot masquerade as scope-owned
by dropping its lock. A committed lock's approval survives restore when the
restored artifact hashes to the locked integrity.

Bundled framework packages are trusted. Packages you author at a scope live in
`.agents/capabilities/owned/` and are config-owned trusted — trusting the
scope trusts them; review them like other repository instructions and code.
In a git-managed scope they are committed; at a non-git scope (the laptop
level, a plain workspace root) they are ordinary files whose durability is the
scope's own — they have no lock and are not restorable by `oas install`, so
back them up with whatever backs up that scope. Capabilities directly
under `.agents/capabilities/` are rejected — move them into `installed/` or
`owned/`.

## Activation and exclusions

```bash
oas use oas.okf --global --dir /path/to/repo
oas use example.code-review --group developers --dir /path/to/repo
oas use example.deploy --group reviewers --disable --dir /path/to/repo
oas use example.deploy --soul release-reviewer --dir /path/to/repo
```

`--global` is the default. Choose only one target. An integration's manifest
declares its layer, so activation does not repeat it. Disable an inherited
fundamental layer with `oas use none --layer <layer>`.

## Commands and hooks

Operational commands resolve only when their package is active in the current
instance or soul context. Package-management commands (`install`, `trust`,
`use`, `doctor`) remain available globally.

Hooks receive `OAS_EVENT`, `OAS_CAPABILITY`, `OAS_LAYER`, `OAS_INSTANCE`,
`OAS_HOME`, `OAS_AGENT`, `OAS_SOUL`, `OAS_CONTEXT`, `OAS_WORKSPACE`,
`OAS_ROOT`, `OAS_LEVEL`, `OAS_SETTINGS`, and `OAS_META`. A final JSON line may
return `meta`, `brief`, or `warning`.

Spawn/scaffold order is outer scope to inner scope, then capability ID;
retirement reverses successful spawn order. Scaffold hooks cannot modify or
delete canonical or another package's files. OAS records ownership, restores
the pre-hook snapshot, and raises a conflict instead of accepting destructive
or last-writer-wins behavior.

## Bundled packages

| Capability | Kind | Provides |
|---|---|---|
| `oas.okf` | knowledge integration | OKF bundles, instance memory, harvest skills and command |
| `oas.aweb` | messaging integration | aweb identity lifecycle and messaging skills |
| `oas.jira` | tasks integration | Jira task protocol via `acli` |
| `oas.linear` | tasks integration | Linear GraphQL task commands and workflow |
| `oas.authoring` | additive | capability, skill, and soul authoring guidance |

The source packages live under `capabilities/`. Acquired packages live under
`<level>/.agents/capabilities/installed/` (gitignored, restorable); packages
authored at a scope live under `<level>/.agents/capabilities/owned/`
(committed where the scope is a git repo). Within one scope `owned/` overrides `installed/` on ID collision.
