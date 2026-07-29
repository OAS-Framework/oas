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
    { "command": "team-chat", "why": "send and receive messages" },
    {
      "runtime": "pi",
      "package": "npm:team-chat-pi",
      "why": "real-time push events in pi sessions"
    }
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
- Only `soul-scaffold`, `spawn`, and `retire` hooks are accepted. A hook is a
  command string, or `{ command, required }`. `required: true` is valid **only
  on `spawn`**: the hook's failure then fails the spawn and rolls it back,
  instead of producing an instance whose capability never configured itself —
  an aweb identity that could not be minted leaves an agent believing it can be
  woken by mail. Every other hook stays best-effort and only warns, so advisory
  work never becomes a spawn blocker. `retire` and `soul-scaffold` cannot be
  required: they run outside a spawn transaction, so there is no moment to
  enforce them.
- A capability declaring a **required** spawn hook should declare a `retire` hook
  too. Without one, OAS has no way to undo what the spawn hook did and no way to
  know whether it did anything, so a failure quarantines the home rather than
  rolling it back — the operator cleans up by hand and removes it with `--force`.
- A required hook must also be **able** to run: if its capability's executable
  surface is not trusted, the spawn fails with the `oas trust` remedy rather
  than starting without the setup. Advisory executable hooks stay
  disabled-with-warning.
- When a required hook fails and its compensation cannot finish, the instance
  home is **retained**, not deleted — it holds the credentials and metadata a
  retry needs, and removing it would turn a transient cleanup failure into
  permanent external residue. It is marked `.oas-rollback-incomplete.json`, so
  `oas status` reports it as retained state rather than a live instance, and
  `oas retire <instance>` retries the cleanup — re-running the retire hooks and
  the rollback-owned Git steps, and verifying both. A retry that still cannot
  finish keeps the home again, names what is outstanding, and exits nonzero.
- The **escape hatch is `oas retire <instance> --force`**, for a home OAS cannot
  identify at all: no `instance.json` and no **usable** cleanup descriptor. Usable
  means it satisfies the versioned cleanup contract the rollback writes, checked
  to the depth the retry consumes it: `version`, a context `repo`, a recognised
  `work` mode (plus a `branch` for `worktree` — an unknown mode would skip the
  rollback-owned Git cleanup and call it done), a real non-empty capability set,
  and the record of what still owes cleanup — retire hooks by capability id, plus
  the rollback-owned Git steps (`worktree`, `branch`) where the mode has them. That
  record can never be empty: a quarantine exists because something is outstanding,
  and one claiming otherwise would give the retry nothing to prove. A marker failing any of
  that is no more retryable than a missing one, and is treated as missing so the
  escape hatch works.
- A retry clears the quarantine only by **proving the outstanding work happened**:
  every retire hook the marker records as owing cleanup must have run and reported
  success, and every Git step it records must be re-run and verified. A retry that resolves no
  capabilities — a hand-edited descriptor, or config drift since the spawn — is an
  incomplete cleanup, not a clean one, and the home stays.
- Because some cleanups can never succeed (a capability offering no way to undo its
  own setup, a permanently unreachable remote), **`--force` also overrides
  retention**: the home is removed, and everything still outstanding is printed as
  state the operator now owns. Nothing is ever permanently unremovable through OAS,
  and nothing is silently dropped. Without `--force` that state fails closed with
  `E_UNIDENTIFIED_INSTANCE_HOME` rather than deleting whatever credentials the
  directory still holds; `--force` removes it and leaves any external state for
  the operator to clean up by hand.
- `requires` declares what must exist before the capability works. Two kinds:
  - a **host command** (`command`), satisfied by a binary on `PATH`;
  - a **runtime package** (`runtime` + `package`, optionally `marketplace`),
    satisfied by that runtime's own package manager — `npm:@scope/name` for pi,
    `plugin@marketplace` for Claude Code. It is raised only for deployments that use the named
    runtime — a Claude-only deployment is never asked to install a pi package —
    and is verified in the runtime's package list, never on `PATH`. A version
    selector is allowed and ignored for identity, so `@latest` and a pinned
    version are one requirement.
  A runtime package is **verified at spawn, never installed there**: installing
  would mutate the operator's runtime configuration without asking, in the
  middle of a spawn. A missing, uninstalled or disabled package fails the spawn
  with the consent command that fixes it.
- OAS never installs a requirement silently. `oas install` prompts per
  requirement with the exact argv, source and scope; automation passes
  `--accept-requirement <name>` (the name is the command, or
  `<runtime>:<package>`), and `--no-requirements` skips the gate. When a plan
  has several steps — registering a Claude marketplace before installing from
  it — every step is shown, because agreeing to a plugin also means agreeing to
  the source it comes from. Declining
  leaves an actionable `oas doctor` warning. Consent to install is separate
  from capability trust.
- Target names never appear in a package manifest.

`capability` is the only manifest identity field. The machine-readable
contract is [`capability-manifest.schema.json`](capability-manifest.schema.json).

## Config and targets

```yaml
agent-types:
  developers:
    description: Agents that build the service (souls declare `type: developers`)
  reviewers:
    description: Agents that review changes

capabilities:
  layers:
    knowledge:
      capability: oas.okf
      from: installed
      # injection-override: .agents/injections/capabilities/oas.okf.md
    messaging: none
    tasks: none

  additive:
    example.code-review:
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

    example.deploy:
      from: installed
      global: true
      agent-types:
        reviewers: false       # explicit exclusion
      souls:
        release-reviewer: true # more-specific re-enable

skill-overrides:
  review: example.code-review
```

`global` means all souls governed by the config level declaring it—not every
soul on the machine regardless of scope. Laptop, workspace, and repository
configs each govern souls beneath that level.

Composition is additive across matching global, agent-type, and soul
bindings. Settings use `soul > agent-type > global`, then closer config scope.
Conflicting values at equal specificity and scope are errors.
`enabled: false` follows the same precedence. Agent types are declared by
name in config; each soul opts in via `type:` in its soul.yaml. Tags and
selectors are not implemented, and bindings do not target individual
instances.

`capabilities` is the only activation map: fundamental integrations live
under `capabilities.layers.<layer>` (an entry or an explicit `none` that
suppresses an inherited integration), everything else under
`capabilities.additive`.

## Exact runtime composition

Every spawned instance receives:

- canonical soul skills;
- the kernel `oas` skill; and
- skills from capabilities active for that soul.

OAS copies only those skill trees into real directories under
`<instance>/.agents/skills/` and records the names and source capability in
`instance.json`. `.claude/skills` points to
the same canonical directory. Pi launches with this directory as an explicit
skill path; ambient skills (user-level, pi packages, the work tree) coexist
with the OAS-composed set rather than being excluded — `instance.json`
records exactly what OAS composed, not everything the harness may discover.
`oas-getting-started` is the pi adapter's one ambient contribution before a workspace exists.

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

## Distribution packages

A **distribution package** is the install/update/review unit above
capabilities: a directory with an `oas-package.json` manifest that explicitly
enumerates one or more capabilities and optional reference config templates
(schema:
`docs/oas-package.schema.json`; contract:
`docs/design/package-engine-contract.md`). A capability remains the
targeting/activation unit — every capability a package exports stays
independently addressable by ID with `from: installed`.

A Git repository *contains* that directory; `#<path>` selects which one, and
only the selected subtree is installed and hashed. Omitting it selects
`oas-package/` (the convention for every official example and scaffold); `#.`
selects the repository root. Local paths are always exact directories.

```bash
oas install git:github.com/org/repo@v1.0.0 --dir /path/to/scope   # git shorthand → oas-package/
oas install git:github.com/org/repo@v1.0.0#dist/oas                # a custom contained root
oas install https://host/org/repo.git@v1.0.0#.                     # raw git URL, repository root
oas install ../my-package                                          # local path (exact directory)
oas install oas.okf                                                # official catalog id
oas install                     # bare: exact restore of this chain's locks
oas list                        # installed packages, exported capabilities, scopes
oas update <package>            # transactional re-resolve + diff + trust reset
oas remove <package>            # refuses while config/dependents reference it
oas migrate [--dry-run]         # map v1 capability locks to package locks
```

Installing a package materializes each capability into the owning scope's
`.agents/capabilities/installed/<id>/` (gitignored, like the capability store).
There is no persistent package store. `oas-lock.json` uses `lockfileVersion: 2`
with two maps: `packages` (exact source, commit, selected path, payload
integrity, and dependencies) and `capabilities` (each artifact's version,
provider package, path, integrity, and trust) — schema
`docs/oas-lock.schema.json`. Dependencies are pinned (official selector,
tag/commit, or local path — no semver solver). Cycles and two sources claiming
one package identity at a scope are errors with provenance. Acquisition
**activates nothing** and adopts no config template; an unpinned git source
resolves once and never advances on restore.

Trust binds to each materialized capability artifact at its exact integrity.
`oas trust <capability>` approves only that capability's commands and hooks.
`oas trust <package> --all-capabilities` is the explicit bulk path and prints
the full executable surface first. Any artifact integrity change (including
`oas update`) resets that capability's trust.
Skill/instruction/config-only capabilities need lock integrity but no
executable approval, and official-catalog identity grants **no** executable
trust. A capability may carry a checked-in `package-lock.json` for JS runtime
dependencies; OAS materializes it with `npm ci --ignore-scripts` only — npm
lifecycle scripts never run at acquisition, and capability code/hook paths
must resolve inside the materialized capability root.

`oas migrate` converts a scope's v1 marketplace/git/path capability locks to
the revised v2 lock, preserving `from: installed` activation. It is
all-or-nothing per scope: a scope converts only when every entry maps to a
package. If any entry is held, manual, or retained, the whole scope stays
byte-identical v1 and keeps working. There is no residue container, and
executable approvals are never carried over.

All package operations are agent-callable: every command above supports
`--json` (one stdout envelope; failures carry the contract's stable error
codes) and noninteractive operation. Agents never hand-edit `oas-lock.json`
or the stores — the kernel-owned **oas-packages** skill (composed into every
instance) teaches the full lifecycle.

## Acquisition, lock, restore, and trust (single capabilities)

```bash
oas install oas.jira --dir /path/to/repo             # official catalog id; approve executable surfaces with `oas trust`
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

One narrow exception exists for the kernel's own marketplace, kept only until
official packages replace legacy `marketplace:` installs. A capability whose
lock source is `marketplace:<id>@<version>` may declare resources that live
outside its installed copy — `oas.authoring` selects framework skills with
`../../skills/<name>` — and those declarations are resolved against the
capability's directory in the kernel marketplace
(`<kernel>/capabilities/<slug>`), located by capability id rather than by the
lock selector's spelling. If that declared path names an npm dependency hoisted
by npm, OAS also checks the equivalent path from the kernel root; this is the
published `oas.aweb` layout (`node_modules/@awebai/pi/skills/...`). The shipped source must still have the same
capability identity, while its version may advance with an explicitly installed
kernel upgrade: framework-hoisted resources belong to that trusted kernel, and
this preserves valid older v1 installs until official-package migration. The
installed copy and its lock must still agree on version and integrity. If they
do not, recovery is to delete the installed copy the error names and then run
`oas install <id> --dir <scope>`, which re-acquires and rewrites the lock entry;
run with the copy still in place, that command reports `Already acquired` and
changes nothing, and legacy v1 capability entries are not removable with
`oas remove`, which services packages. Such a tree may leave the
installed copy but never the kernel package: `..` segments and symlinks that
resolve outside it are rejected exactly like any other escape. Capabilities
exported by packages, authored at a scope, or referenced by path never receive
this resolution — they stay inside their own artifact.

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
oas use example.code-review --type developers --dir /path/to/repo
oas use example.deploy --type reviewers --disable --dir /path/to/repo
oas use example.deploy --soul release-reviewer --dir /path/to/repo
```

`--global` is the default. Choose only one target. An integration's manifest
declares its layer, so activation does not repeat it. Disable an inherited
fundamental layer with `oas use none --layer <layer>`.

## Capability-defined agents

A manifest may declare `agents: ["agents/<name>"]` — package-relative soul
directories (`soul.yaml` + `AGENTS.md` directly inside). Wherever the
capability is **declared** in the config chain, `oas spawn <name>` resolves
these like local souls: the canonical soul stays read-only inside the package
(a fresh identity every spawn — by design for service agents like reviewers),
while instances home under the scope's `local-agents/`. Capability agents
carry their own `model:`/`runtime:` defaults in soul.yaml.

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
