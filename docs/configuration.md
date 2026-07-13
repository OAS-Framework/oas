# Configuration

OAS configuration lives in `oas-config.yaml` at a laptop, workspace, or
repository root. It owns deployment policy: acquired capability declarations,
explicit soul groups, activation targets, settings, exclusions, instruction
sources, work modes, and explicit inherited-layer disables.

Packages never declare their targets. See the machine-readable
[`oas-config.schema.json`](oas-config.schema.json) alongside the examples below.

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

groups:
  developers: [api-expert, ui-expert]
  reviewers:
    souls: [security-reviewer, release-reviewer]

capabilities:
  oas.okf:
    source: bundled
    global:
      enabled: true
      settings:
        harvest-model: github-copilot/gpt-5.5

  example.review:
    source: git:https://example.invalid/review.git
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
      reviewers: false
    souls:
      release-reviewer: true

skill-overrides:
  review: example.review

agents-md-injection:
  repository: injects/repository.md

oas:
  agents-md-injection: default

work-modes:
  worktree:
    agents-md-injection: default
    setup: scripts/setup-worktree.sh
  checkout:
    agents-md-injection: default
```

### `groups`

V1 groups are config-owned explicit soul lists. A group can use an inline list
or `souls:`. Tags, dynamic selectors, and instance names are not supported.
Closer declarations replace an outer group with the same name.

### `capabilities`

A package declaration without `global`, `groups`, or `souls` is acquired but
inactive. A target value can be `true`, `false`, or an object containing
`enabled` and `settings`.

For a soul, matching global, group, and soul bindings compose. Setting
precedence is:

1. soul;
2. matching group;
3. global;
4. at equal target specificity, closer config scope.

Conflicting values at equal specificity and the same scope are errors. OAS
never uses YAML order as an implicit winner. `enabled: false` uses the same
precedence, allowing global enable → group exclusion → soul re-enable.

An active capability whose manifest declares `layer: knowledge|messaging|tasks`
is the integration selected for that fundamental layer. More than one active
integration for the same layer is an error.

A capability declaration may also carry `agents-md-injection` to override that
package's packaged instruction injection: a config-relative path replaces it,
`none` suppresses it, and `default` restores the packaged file. The closest
scope declaring the key wins.

### `skill-overrides`

Spawn fails when two sources contribute the same skill directory name. An
explicit override maps that name to the winning source (`soul`, `kernel`, a
capability ID, or a config source shown by doctor). Overrides are deliberate;
OAS never keeps whichever filesystem entry happened to be discovered first.

### Instruction sources

`agents-md-injection` adds unconditional config-owned instruction files.
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
oas use <capability> [--global|--group <g>|--soul <s>] [--disable]
oas use none --layer <layer>
oas doctor [context] --soul <name> [--json]
```

`oas init` writes only explicitly selected defaults. It may discover many
bundled or installed packages, but does not activate all of them.

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
layers:
  tasks: none
```

These three `none` values are the only accepted `layers` entries. Activate an
integration by its namespaced ID under `capabilities`; its manifest supplies
the layer. Pre-release `integrations`, `providers`, provider-valued `layers`,
and `.agents/workspace.yaml` shapes are not part of this first contract.

## Worked examples

### All souls use OKF; only developers use Linear

```yaml
groups:
  developers: [backend, frontend]
capabilities:
  oas.okf:
    global: true
  oas.linear:
    groups:
      developers:
        enabled: true
        settings: {team: ENG, project: Product}
```

### Laptop default with repository exclusion

Laptop:

```yaml
capabilities:
  oas.aweb:
    global: true
```

Solo repository:

```yaml
capabilities:
  oas.aweb:
    global: false
```

### One marketplace capability for one soul

```yaml
capabilities:
  vendor.security-review:
    source: git:https://example.invalid/security-review.git
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
