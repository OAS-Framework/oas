# Configuration

OAS configuration lives in `oas-config.yaml` at a laptop, workspace, or
repository root. It owns deployment policy: agent-type declarations, the three
fundamental layer slots, additive capability activations, settings,
exclusions, instruction overrides, and work modes.

The CLI is the primary config author: `oas init` scaffolds the full shape,
`oas use` writes capability entries, `oas create --type` sets a soul's type.
Hand-editing is valid but never required. Packages never declare their
targets. See the machine-readable
[`oas-config.schema.json`](oas-config.schema.json) alongside the examples
below.

## Scopes

Resolution walks from the soul's repository upward:

1. repository;
2. containing workspace(s); and
3. laptop/home.

A `global` binding applies to all souls governed by the level that declares
it. It does not escape that scope. This lets a laptop set defaults, a workspace
add shared team capabilities, and one repository make a narrower choice.

```text
~/oas-config.yaml
~/workspace/oas-config.yaml
~/workspace/service/oas-config.yaml
```

Use `oas doctor <context> --soul <name>` to inspect the result.

## Schema

```yaml
name: example-service

# ── Team — the deployment boundary. The closest scope declaring team: wins;
# every repo under it resolves the same team (identity, discovery, messaging).
team:
  name: example-engineering
  # id: example-engineering:example.com   # explicit provider team id (e.g. aweb <name>:<namespace>)

# ── Agent types (families) ── declared here by name; each soul opts in via
# `type: <name>` in its soul.yaml. Capability entries can target them.
agent-types:
  developers:
    description: Agents that build and maintain the service
  reviewers:
    description: Agents that review changes

capabilities:
  # Fundamental layers — exclusive slots; a capability entry or an explicit none.
  layers:
    knowledge:
      capability: oas.okf
      from: installed
      settings:
        harvest-model: github-copilot/gpt-5.5
      # injection-override: .agents/injections/capabilities/oas.okf.md
    messaging: none
    tasks:
      capability: oas.linear
      from: installed
      agent-types:
        developers:
          enabled: true
          settings: {team: ENG}
      # injection-override: .agents/injections/capabilities/oas.linear.md

  # Additive capabilities — non-exclusive; target global, agent-types, or souls.
  additive:
    example.review:
      from: installed
      agent-types:
        developers:
          enabled: true
          settings:
            depth: normal
      souls:
        security-reviewer:
          enabled: true
          settings:
            depth: exhaustive
      # injection-override: .agents/injections/capabilities/example.review.md

skill-overrides:
  review: example.review

# ── Work modes — optional per-mode env bootstrap (briefings are packaged, not overridable).
work-modes:
  worktree:
    # Runs inside each NEW worktree right after `git worktree add` — env setup
    # scripts (installs, .env copying, direnv/mise). Relative to this config's dir.
    setup: scripts/setup-worktree.sh

# ── OAS defaults — the framework's baseline instruction block.
oas:
  # injection-override: .agents/injections/oas-defaults/oas.md

# Extra unconditional instruction blocks for every instance at this scope.
agents-md-injection:
  repository: injects/repository.md
```

### `team`

`team:` declares the deployment boundary — typically at the workspace scope.
The closest scope declaring it wins, so every repo under `~/lfx` resolves the
same team. `name:` is required; `id:` optionally pins the provider team id
(for aweb, the canonical `<name>:<namespace>` form). Three things hang off
it:

- **Identity**: instances record their team in `instance.json` and their
  TASK.md briefing; hooks receive `OAS_TEAM_NAME`/`OAS_TEAM_ID`/`OAS_TEAM_SCOPE`.
- **Discovery**: `oas status --team` lists agents across every `agents/`
  root in the team scope (the scope's own plus each member repo's), so an
  agent in one repo can see teammates defined at the workspace level or in
  sibling repos. There is no explicit member list — every repo under the
  team scope is a member by construction.
- **Cross-repo spawn/retire**: `oas spawn <soul>` and `oas retire <instance>`
  resolve across the team scope's repos when the name isn't found locally
  (unique match wins; ambiguity errors with guidance to pass `--dir`). The
  instance homes with the soul's own repo, works in that repo, and resolves
  that repo's config chain — spawning from elsewhere changes nothing about
  the instance itself.
- **Messaging**: the aweb integration joins spawned instances into the
  resolved team (id wins over name; a bare name is resolved against the aweb
  root's memberships), with the instance name as the discoverable alias.
  Because every instance joins with its own name, the aweb team roster is
  also the **cross-machine directory**: `oas aweb roster` lists team members
  wherever they run, complementing the local `oas status --team`.

### `agent-types`

Agent types are agent families. Config declares type names (optionally with a
description); membership is **not** listed in config — each soul opts in with
an optional single `type: <name>` in its `soul.yaml` (`oas create --type <t>`
sets it; `oas type add <name>` declares it in config). A type is identity: what kind of agent a soul is travels with the
soul, while config decides what each type gets. Tags, dynamic selectors, and
instance names are not supported.

### `capabilities.layers`

The three fundamental layers — `knowledge`, `messaging`, `tasks` — are
exclusive slots with an explicit home. Each slot holds either a capability
entry (`capability: <id>` plus optional `from`, targets, `settings`,
`injection-override`) or the explicit string `none`, which suppresses an integration
inherited from an outer scope. A slot absent from a config inherits from
outer scopes; `oas init` writes all three so the resolution is visible.

The entry's capability must declare the same layer in its manifest; a
mismatch is an error, as is a layer-declaring capability placed under
`additive`. A layer entry with no explicit targets is globally enabled at
that scope.

### `capabilities.additive`

Additive capabilities are non-exclusive packages keyed by capability ID. A
declaration without `global`, `agent-types`, or `souls` is acquired but
inactive. A target value can be `true`, `false`, or an object containing
`enabled` and `settings`.

For a soul, matching global, agent-type, and soul bindings compose. Setting
precedence is:

1. soul;
2. matching agent-type;
3. global;
4. at equal target specificity, closer config scope.

Conflicting values at equal specificity and the same scope are errors. OAS
never uses YAML order as an implicit winner. `enabled: false` uses the same
precedence, allowing global enable → type exclusion → soul re-enable.

### `from` (provenance)

`from:` documents where the artifact must come from, and resolution enforces
it: `installed` (acquired into `.agents/capabilities/installed/`,
lock-governed — from the official marketplace by id, a git URL, or a local
path), `owned` (authored at this scope under `.agents/capabilities/owned/`),
or `path:<dir>` (development declaration pointing at a manifest directory).
A mismatch between `from:` and the discovered artifact origin is an error.
`from: bundled` was removed. Official capabilities are acquired like any other
package, and acquisition never grants executable trust — approve executable
surfaces explicitly with `oas trust <capability>`.

### `injection-override`

Every injectable item — each capability entry, each work mode, and the `oas:`
kernel block — accepts an `injection-override:` key: a config-relative path replaces
the packaged instruction file, `none` suppresses it, and `default` restores
it. The closest scope declaring the key wins. Scaffolded configs carry these
as commented-out lines pointing at the conventional locations:

```text
.agents/injections/capabilities/<capability-id>.md
.agents/injections/oas-defaults/oas.md
```

The clean path is `oas inject eject <capability|oas>`: it copies
the packaged default to the conventional path and sets the key — the ejected
file then deliberately stops tracking package updates. Overrides are not
allowed on `from: owned`/`path:` entries: the scope owns the package source,
so its `injects/` file is edited directly.

### `skill-overrides`

Spawn fails when two sources contribute the same skill directory name. An
explicit override maps that name to the winning source (`soul`, `kernel`, a
capability ID, or a config source shown by doctor). Overrides are deliberate;
OAS never keeps whichever filesystem entry happened to be discovered first.

### Instruction sources

`agents-md-injection` adds unconditional config-owned instruction files (it
adds content; it does not override packaged defaults — that is `injection-override:`).
Capability packages can ship an `inject`; work modes have their own source.

OAS reads the canonical soul `AGENTS.md`, composes selected blocks in a new
instance file, and records every source. It never reconciles deployment
instructions into the committed soul; spawn and doctor are the composition
boundaries.

### Work modes

Work modes remain soul/instance topology, not capability packages:

- `worktree`: dedicated branch/worktree;
- `checkout`: shared current checkout;
- `attached`: another instance's work tree;
- `workspace`: the whole team scope — cross-repo coordinators that read all
  member repos but never edit them (their soul's knowledge updates arrive as
  PRs to the soul's home repo).

Work-mode briefings are packaged with the kernel and are not overridable;
the only work-mode configuration is `setup:` — an env-bootstrap command that
runs inside each fresh worktree after creation (a lot of teams prefer a
script that sets up the environment: installs, .env copying, direnv/mise).
Its failure warns without hiding the instance.

## Acquisition and lockfile

External acquisition writes `oas-lock.json` beside the declaring config in
`lockfileVersion: 2`. It records two levels — a `packages` map (source, exact
commit, selected path, payload integrity, dependencies) and a `capabilities`
map (each materialized capability's version, provider package, path, artifact
integrity, and executable trust):

```json
{
  "lockfileVersion": 2,
  "packages": {
    "example.engineering": {
      "source": "git:https://example.invalid/engineering.git@v1.4.2",
      "version": "1.4.2",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "path": "oas-package",
      "integrity": "sha256-…",
      "dependencies": []
    }
  },
  "capabilities": {
    "example.review": {
      "version": "1.4.2",
      "package": "example.engineering",
      "path": "capabilities/example-review",
      "integrity": "sha256-…",
      "trusted": false
    }
  }
}
```

No command silently updates this record. Changed capability integrity blocks the
artifact and resets its trust. `oas trust <id>` approves commands and hooks only
for the exact locked artifact integrity, and official identity never grants it.
Declarative skill/instruction capabilities need a valid lock but no executable
approval. Capabilities authored under a scope's `.agents/capabilities/owned/`
follow their reviewed source provenance. Materialized artifacts live in
`.agents/capabilities/installed/<id>/` beside their lock, stay gitignored, and
are re-materialized by bare `oas install` with integrity verification.

Legacy `lockfileVersion: 1` locks (per-capability marketplace installs) remain
readable and usable. `oas migrate` converts a scope to the revised v2 lock
**all-or-nothing**: if any entry cannot map to a package yet, the whole scope
stays byte-identical v1 and keeps working, and a successful run converts the
entire scope at once. There is no residue container — a converted lock never
carries leftover v1 entries. The earlier transitional v2 shape — capability
lists on package rows, a persistent `.agents/packages/installed/` store — is
rejected as an invalid lock and recreated by a fresh acquisition, never
migrated. See `docs/capabilities.md` (“Distribution packages”), the schemas
`docs/oas-package.schema.json` / `docs/oas-lock.schema.json`, and
`docs/design/package-engine-contract.md`.

## CLI

```bash
oas init [--raw] [--template <name|path|git-url>] [--knowledge <id|none>] [--messaging <id|none>] [--tasks <id|none>]
oas install [<id|git-url|path>] [--dir <dir>]  # acquire; bare form restores; inactive by default
oas trust <capability> [--dir <dir>]
oas use <capability> [--global|--type <t>|--soul <s>] [--disable] [--settings k=v [k2=v2 ...]]
oas use none --layer <layer>
oas type add <name> [--description <d>]   # declare an agent type
oas type list
oas inject eject <capability|oas>  # materialize an injection override
oas create <name> --type <agent-type> ...
oas doctor [context] --soul <name> [--json]
```

`oas init` writes only explicitly selected defaults, acquiring marketplace
layer capabilities into this scope's installed/ store as needed; it does not
activate every acquired package. `oas use`
places a layer-declaring capability under `capabilities.layers.<layer>` and
everything else under `capabilities.additive`, regenerating the conventional
injection comments; custom comments inside the `capabilities:` block are not
preserved.

`oas use` activates **into a config file**, so it needs one at this scope or an
outer one. In a scope with no `oas-config.yaml` anywhere in its chain, a
capability already present in that scope's own `installed/` or `owned/` store
fails with `E_NO_CONFIG` naming the initialization to run first — exactly
`oas init --raw --dir <scope>`, which is offline, deterministic and writes only
the minimal config — and then the same `oas use` command again. It never
reports the capability as unacquired, and it writes nothing: authoring a
scope's first config is `oas init`'s job.

### Templates

`oas init --template <name|path|git-url>` seeds the new config from a template
config file: a local path, a git URL whose default branch carries an
`oas-config.yaml`, or a name resolved through a `templates:` map declared in an
outer scope (typically the laptop config):

```yaml
# ~/oas-config.yaml
templates:
  personal: ~/templates/personal-oas-config.yaml
  team: https://example.invalid/oas-templates.git
```

A template seed is copied once. `init` copies the content, records provenance in
a leading `# template:` comment, rewrites `name:`, strips the `templates:` map,
and runs a restore so declared external capabilities are present. Later template
edits never propagate silently.

### Package config templates

When the config and its capability providers travel together, prefer
`oas init --package <source> [--config <name>]`. It validates a reference config
template shipped by a distribution package and writes it as your local
`oas-config.yaml`, recording the exact template as a commit-safe adopted base
with package, template, and commit provenance. `oas config diff` and
`oas config sync` compare against that base later. Installing the package alone
adopts no template. See [Distribution packages](packages.md).

## Fundamental-layer disable

An inner scope can suppress an inherited integration without selecting a
replacement:

```yaml
capabilities:
  layers:
    tasks: none
```

`oas use none --layer tasks` writes this. Pre-v0.9 spellings (`groups:`,
top-level `layers:`, flat `capabilities.<id>` maps, `source:`,
`agents-md-injection` on capability entries) are rejected with pointed
migration errors. Key names are matched as own properties only, so a key
spelled `constructor` or `toString` is reported as an unsupported key, never as
a renamed one. `__proto__` is refused outright by the YAML readers
(`unsafe-config-key`): assigning it rewrites the parsed mapping's prototype
instead of becoming data, which would hide the entry from every key validator.

## Worked examples

### All souls use OKF; only developers use Linear

```yaml
agent-types:
  developers:
    description: Souls with type: developers in their soul.yaml
capabilities:
  layers:
    knowledge:
      capability: oas.okf
      from: installed
    tasks:
      capability: oas.linear
      from: installed
      agent-types:
        developers:
          enabled: true
          settings: {team: ENG, project: Product}
```

### Laptop default with repository exclusion

Laptop:

```yaml
capabilities:
  layers:
    messaging:
      capability: oas.aweb
      from: installed
```

Solo repository:

```yaml
capabilities:
  layers:
    messaging: none
```

### One marketplace capability for one soul

```yaml
capabilities:
  additive:
    vendor.security-review:
      from: installed
      souls:
        security-reviewer: true
```

Acquire and trust executable surfaces before spawn; target activation alone
does not download, update, or approve code.

## Tmux scrolling during init

Interactive `oas init` offers to add `set -g mouse on` to the existing
`~/.tmux.conf` or XDG tmux config so agent windows scroll normally with a mouse
or trackpad. It never changes terminal keyboard mappings. Agent-led and
scripted setup should pass the user's answer explicitly:

```bash
oas init --tmux-mouse
oas init --no-tmux-mouse
oas init --raw --tmux-mouse
```

An accepted change is idempotent and reloads a running tmux server when
possible. This machine preference is separate from capability acquisition and
activation.
