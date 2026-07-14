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
      from: bundled
      settings:
        harvest-model: github-copilot/gpt-5.5
      # injection-override: .agents/injections/capabilities/oas.okf.md
    messaging: none
    tasks:
      capability: oas.linear
      from: bundled
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

# ── Work modes — per-mode instruction overrides and setup hooks.
work-modes:
  worktree:
    # injection-override: .agents/injections/workmodes/worktree.md
    setup: scripts/setup-worktree.sh
  checkout:
    # injection-override: .agents/injections/workmodes/checkout.md
  attached:
    # injection-override: .agents/injections/workmodes/attached.md

# ── OAS defaults — the framework's baseline instruction block.
oas:
  # injection-override: .agents/injections/oas-defaults/oas.md

# Extra unconditional instruction blocks for every instance at this scope.
agents-md-injection:
  repository: injects/repository.md
```

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
it: `bundled` (ships with the kernel), `installed` (acquired into
`.agents/capabilities/installed/`, lock-governed), `owned` (authored at this
scope under `.agents/capabilities/owned/`), or `path:<dir>` (development
declaration pointing at a manifest directory). A mismatch between `from:` and
the discovered artifact origin is an error.

### `injection-override`

Every injectable item — each capability entry, each work mode, and the `oas:`
kernel block — accepts an `injection-override:` key: a config-relative path replaces
the packaged instruction file, `none` suppresses it, and `default` restores
it. The closest scope declaring the key wins. Scaffolded configs carry these
as commented-out lines pointing at the conventional locations:

```text
.agents/injections/capabilities/<capability-id>.md
.agents/injections/workmodes/<mode>.md
.agents/injections/oas-defaults/oas.md
```

The clean path is `oas inject eject <capability|work-mode|oas>`: it copies
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
- `attached`: another instance's work tree.

A worktree `setup` command runs after creation. Its failure warns without
hiding the instance.

## Acquisition and lockfile

External acquisition writes `oas-lock.json` beside the declaring config:

```json
{
  "lockfileVersion": 1,
  "capabilities": {
    "example.review": {
      "source": "git:https://example.invalid/review.git",
      "version": "1.4.2",
      "commit": "0123456789abcdef",
      "integrity": "sha256-…",
      "trustedExecutables": false
    }
  }
}
```

No command silently updates this record. Changed integrity blocks the package.
`oas trust <id>` approves commands/hooks only for the exact locked integrity.
Declarative skill/instruction packages need a valid lock but not executable
approval. Bundled packages and packages authored under a scope's
`.agents/capabilities/owned/` follow their reviewed source provenance.
Acquired artifacts live in `.agents/capabilities/installed/` beside their
lock, stay gitignored, and are reacquired by bare `oas install` with integrity
verification.

## CLI

```bash
oas init [--raw] [--template <name|path|git-url>] [--knowledge <id|none>] [--messaging <id|none>] [--tasks <id|none>]
oas install [<id|git-url|path>] [--dir <dir>]  # acquire; bare form restores; inactive by default
oas trust <capability> [--dir <dir>]
oas use <capability> [--global|--type <t>|--soul <s>] [--disable] [--settings k=v ...]
oas use none --layer <layer>
oas type add <name> [--description <d>]   # declare an agent type
oas type list
oas inject eject <capability|work-mode|oas>  # materialize an injection override
oas create <name> --type <agent-type> ...
oas doctor [context] --soul <name> [--json]
```

`oas init` writes only explicitly selected defaults. It may discover many
bundled or installed packages, but does not activate all of them. `oas use`
places a layer-declaring capability under `capabilities.layers.<layer>` and
everything else under `capabilities.additive`, regenerating the conventional
injection comments; custom comments inside the `capabilities:` block are not
preserved.

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

Templates are snapshots: init copies the content, records provenance in a
leading `# template:` comment, rewrites `name:`, strips the `templates:` map,
and runs a restore so declared external capabilities are present. Later
template edits never propagate silently.

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
migration errors.

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
      from: bundled
    tasks:
      capability: oas.linear
      from: bundled
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
      from: bundled
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
