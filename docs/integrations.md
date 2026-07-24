# Integrations

An **integration is a capability package selected to satisfy one exclusive
fundamental layer**: knowledge, messaging, or tasks. The layer model remains a
formal part of OAS; capability packages generalize how its implementations and
other reusable agent features are distributed and targeted.

Read [Capability packages](capabilities.md) first for manifests, acquisition,
targeting, instance-local composition, locks, trust, hooks, and commands.

## Fundamental-layer contract

For each soul, OAS resolves zero or one implementation for each pluggable
layer:

| Layer | Contract | Bundled choices |
|---|---|---|
| knowledge | capture, durable knowledge form, and promotion lifecycle | `oas.okf` |
| messaging | reachable instance identity and human/agent communication | `oas.aweb` |
| tasks | durable work queue, ownership, and status | `oas.jira`, `oas.linear` |

A capability manifest becomes an integration by declaring one `layer`. It may
not declare several layers. Two active packages for the same layer are a
configuration error; general capabilities without `layer` remain additive.

This exclusivity matters. For example, task state belongs to the selected task
integration even if a messaging tool also happens to offer task features.

## Selecting an integration

New config activates the package for the intended target:

```yaml
agent-types:
  product-agents:
    description: Planner/developer/reviewer souls (they declare `type: product-agents`)

capabilities:
  layers:
    knowledge:
      capability: oas.okf
      from: installed
    messaging:
      capability: oas.aweb
      from: installed
      agent-types:
        product-agents:
          enabled: true
          settings:
            team: example-team
    tasks:
      capability: oas.linear
      from: installed
      agent-types:
        product-agents:
          enabled: true
          settings:
            team: ENG
            project: Agent Platform
```

Every matching soul gets one knowledge, messaging, and tasks implementation.
A non-matching soul can resolve a different integration or leave a layer
unresolved.

CLI equivalents:

```bash
oas use oas.okf --global
oas use oas.aweb --type product-agents
oas use oas.linear --type product-agents
```

The manifest-declared layer makes a separate CLI/config layer selection
unnecessary — `oas use` writes the entry under `capabilities.layers.<layer>`.
To leave an inherited layer deliberately unfilled, use
`oas use none --layer <layer>` (writes `capabilities.layers.<layer>: none`).

## Bundled integrations

### `oas.okf`

The knowledge integration creates OKF soul bundles, instance `STATE.md`,
`log.md`, and `notes/`, and exposes the `okf` and `memory-harvest` skills. The
instance-triggered `oas okf harvest` command promotes pending notes after a
commit. Its scaffold/spawn hooks own memory mechanics; the kernel remains
knowledge-format agnostic.

### `oas.aweb`

The messaging integration mints an instance identity at spawn, removes it at
retire, and contributes official aweb messaging/team skills. It requires the
`aw` CLI. Messaging does not become the task system.

### `oas.jira`

The Jira tasks integration contributes the `jira-tasks` protocol and an
advisory spawn hook. It requires `acli`; settings commonly include `site` and
`project`.

### `oas.linear`

The Linear tasks integration contributes JSON-first `oas linear` commands,
the `linear-tasks` skill, and an advisory spawn hook. It uses
`LINEAR_API_KEY`; secrets never belong in OAS config. See
`capabilities/oas-linear/README.md` for its support boundary.

> **Removed: `oas.web`.** The browser web-panel capability was retired in
> favor of the OAS Desktop app (`packages/desktop/`), which bundles the same
> zero-dependency loopback server. If an `oas-lock.json` or `oas-config.yaml`
> still names `oas.web`, remove that entry — the capability no longer exists
> in the marketplace. Full migration steps: [docs/desktop-succession.md](desktop-succession.md).

## Build an integration

Use a namespaced capability manifest with exactly one `layer`, then test it as
a capability package. The framework's `integrations-expert` soul remains the
specialist for layer contract design. The `integration-authoring` skill routes
work to it, while the package itself lives under `capabilities/` or
`.agents/capabilities/`.

Do not put target soul names in the manifest. Acquisition, agent types,
activation, settings, exclusions, and overrides belong to `oas-config.yaml`.
