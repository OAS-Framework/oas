# Implementation reference

The reference implementation publishes two npm packages:

- **`@oas-framework/oas`**: runtime-neutral kernel, universal `oas` CLI,
  bootstrap skills, instruction sources, and the official capability marketplace.
- **`@oas-framework/pi`**: minimal pi adapter for instance-local resource
  exposure and memory session events. It registers no agent tools.

Claude instances consume generated standard files directly; OAS redirects
Claude's config home to the instance-local view.

## Repository layout

| Path | Purpose |
|---|---|
| `lib/core.mjs` | Souls, instances, config/target resolver, capability discovery, composition, locks/trust, hooks. |
| `bin/oas.mjs` | Agent lifecycle, config, acquisition/trust/activation, doctor, and operational command dispatch. |
| `capabilities/` | Bundled additive packages and layer integrations, each with `oas.json`. |
| `skills/` | Kernel/bootstrap and package-authoring skills. |
| `injects/` | Kernel and work-mode instruction sources. |
| `packages/pi/` | Thin pi adapter. |
| `packages/desktop/` | OAS Desktop — the Electron control panel and its bundled zero-dependency backend server (private, not published). |
| `test/` | Capability resolver/composition/security lifecycle tests. |
| `agents/` | The framework's own portable expert souls. |

Capability discovery has one layout: each config scope's `.agents/capabilities/` split into
`installed/` (acquired, locked, gitignored, restorable via bare `oas install`)
and `owned/` (authored at that scope, config-owned trusted; committed where
the scope is a git repo, plain scope-durable files elsewhere).

The live control panel is the OAS Desktop app (`packages/desktop/`): an
Electron shell over a bundled zero-dependency localhost server that uses
plain OAS metadata/files plus git and tmux; no pi APIs cross into the
feature, so the same surface works for pi and Claude instances. (`oas pane`
and the `oas.web` browser panel were retired in its favor.)

## Instance layout

```text
<agents-root>/<agent>/
  soul/
    soul.yaml
    AGENTS.md                 # canonical role instructions
    CLAUDE.md -> AGENTS.md
    skills/                   # soul-private skills
  instances/<instance>/
    soul -> ../../soul
    AGENTS.md                 # generated composition (regular file)
    CLAUDE.md -> AGENTS.md
    .agents/skills/           # exact materialized set
    .claude/skills -> ../.agents/skills
    work/
    TASK.md
    instance.json             # capabilities, skills, instruction sources, lifecycle metadata
```

Knowledge integration hooks may add memory files. The kernel does not assume
their names.

## Resolution

`configChain(context)` loads `oas-config.yaml` from closest scope outward.
`resolveCapabilities(context, soulName)`:

1. resolves explicit group definitions;
2. collects matching global/group/soul bindings;
3. composes settings by target specificity then config closeness;
4. applies explicit enable/exclusion;
5. validates equal-specificity conflicts, IDs, command namespaces, lock
   integrity, and skill/layer collisions; and
6. returns deterministic active capability records with provenance.

`resolveOasConfig` maps active packages declaring `layer` into the exclusive
knowledge/messaging/tasks slots. `layers.<layer>: none` explicitly suppresses
an inherited slot and remains distinct from absence.

## Spawn composition

`spawnInstance` resolves against the soul's repository and soul name. It:

1. calls `composeInstanceAgentsMd` without writing the soul;
2. writes generated `AGENTS.md` and canonical compatibility symlinks;
3. copies kernel + soul + active package skill trees into real directories in
   one instance-local root, failing duplicate names unless `skill-overrides`
   chooses a source;
4. creates the selected work topology;
5. runs active hooks in deterministic order; and
6. records capabilities, settings, trust, skill names/sources, instruction
   files, hooks, capability metadata, and forward-only spawn lineage in
   `instance.json`.

Pi launches with `--skill <instance>/.agents/skills` as an explicit path;
ambient discovery (user, packages, work tree) remains enabled so existing
skills coexist with the OAS-composed set. The pi adapter contributes
only `oas-getting-started` outside an instance and the local directory inside
one. Claude discovers the same set through the instance's
`.claude/skills` symlink alongside the user's own configuration.

## Instructions

The generated order is:

1. canonical soul content;
2. kernel OAS block;
3. actual spawn work-mode block;
4. active capability blocks in resolver order; and
5. unconditional config blocks outermost to innermost.

Every generated block carries its source path. `oas doctor --soul <name>` uses
the same composer and prints/returns the final text. Config-dependent prose is
never reconciled into committed souls.

## Acquisition and trust

External installation copies/clones one exact artifact and writes
`oas-lock.json` with source, version/commit, and SHA-256 tree integrity. An
existing destination is never pulled silently. Resolution rejects changed
locked artifacts and unlocked installed/path packages.

Executable package hooks and commands are omitted until `oas trust <id>` marks
the exact locked integrity approved. Bundled packages are framework-trusted.
Packages under a scope's `owned/` subtree are config-owned. Anything under
`installed/` requires a matching lock entry, so an acquired artifact cannot
bypass executable trust by its directory location.

## Hooks and scaffold ownership

Only `soul-scaffold`, `spawn`, and `retire` manifest hooks are accepted.
Spawn/scaffold use outer-scope then capability-ID order; retire reverses it.
Each hook receives package identity/layer plus structured OAS environment and
may emit a final JSON object containing `meta`, `brief`, or `warning`.

Soul scaffolding snapshots files around each package hook and records new-file
ownership in `.oas-scaffold-owners.json`. Overwriting canonical or another
package's file restores the prior bytes and raises a conflict.

## Commands

Kernel/package-management commands are always available. Operational
namespaces are discovered from manifest `command`, but dispatch verifies that
`instance.json` or current soul resolution contains the package and that its
locked executable surface is trusted.

## Verification

```bash
npm test
npm run check
npm run check:pi
npm run validate
npm run validate:okf
npm run pack:check
npm run smoke:tarball
```

Pull-request CI runs this matrix on supported Node 22. `validate` compiles both
public JSON schemas, validates clean-contract manifests, parses documented
OAS config examples with the production parser, and checks maintainable public
local links/anchors. `pack:check` dry-runs both npm packages and rejects missing
runtime surfaces or leaked workspace/test state.

The clean-room smoke test packs both packages, installs their tarballs outside
the checkout, verifies the adapter resolves that installed kernel, runs
`init`/`doctor`, and creates/retires a clean-contract scaffold while checking
exact skills, generated instructions, canonical soul immutability, and
metadata.

These deterministic checks deliberately do **not** contact real aweb, Jira, or
Linear services, validate remote git hosting/auth flows, or publish npm
artifacts. Adapter/discovery changes additionally require a disposable real pi
session from the packed artifacts; external services remain credentialed,
out-of-scope probes. Release CI publishes both
packages from one tag; keep versions synchronized because exact pi isolation
depends on both kernel launch and adapter discovery behavior.

Runtime-neutral token/cost/model/tool telemetry for Control Pane remains a
follow-up; it requires an adapter-neutral event contract rather than pi-specific
inspection in the universal CLI.
