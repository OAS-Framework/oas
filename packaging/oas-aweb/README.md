# oas-aweb

Official [OAS](https://github.com/OAS-Framework/oas) messaging-layer integration for [aweb](https://aweb.ai). It provides:

- per-instance, team-scoped aweb identity minting at spawn and self-deletion at retire;
- bounded authority discovery that never walks above the deployment workspace;
- `oas aweb roster` and guided `oas aweb setup` commands;
- official `aweb-messaging`, `aweb-team-membership`, and `aweb-identity` skills from `@awebai/pi`; and
- a Claude Code channel-plugin launch integration for real-time events.

Messaging is deliberately separate from durable task tracking. The selected tasks integration owns task state.

## Requirements

Install the `aw` CLI and initialize an aweb workspace at the deployment's team scope. `oas aweb setup` reports the next onboarding step without authenticating or creating a team silently.

The inner capability directory owns its JavaScript runtime closure with checked `capabilities/oas-aweb/package-lock.json`. Materialize it exactly, without lifecycle scripts:

```bash
npm ci --omit=dev --omit=peer --ignore-scripts --prefix capabilities/oas-aweb
```

This creates `capabilities/oas-aweb/node_modules/@awebai/pi/skills/...` beside the inner manifest, satisfying all three escape-free skill paths in `oas.json`. The package retains `@awebai/pi` 0.2.x but omits its unused pi-coding-agent peer; the capability consumes the packaged skills, and its commands/hooks do not import that peer. OAS package acquisition must use the same script-free, peer-omitting materialization contract.

The frozen addendum confirms this per-capability closure placement and peer-omitting materialization contract. The package requires OAS `>=0.19.0`; see [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md) for the remaining fixture and conditional advisory gates.

## Acquire and activate

Acquisition does not activate the capability. After an official release exists:

```bash
oas install oas.aweb --dir /path/to/scope
oas trust oas.aweb --dir /path/to/scope
oas use oas.aweb --global --dir /path/to/scope
oas aweb setup
oas doctor /path/to/scope --soul <soul-name>
```

A pinned Git source may be used after publication:

```bash
oas install git:https://github.com/OAS-Framework/oas-aweb.git@v1.5.1 --dir /path/to/scope
```

Commands and identity lifecycle hooks are executable, so they require explicit per-capability trust tied to the exact package integrity. Targeting and team identity are deployment-owned. A typical config scope declares the team boundary and activates the messaging layer:

```yaml
team:
  name: example-team
  id: example-team:aweb.ai
capabilities:
  layers:
    messaging:
      capability: oas.aweb
      from: installed
      global: true
```

## Development

```bash
npm ci --omit=dev --omit=peer --ignore-scripts --prefix capabilities/oas-aweb
npm audit --omit=dev --omit=peer --ignore-scripts --prefix capabilities/oas-aweb
npm test
```

Tests validate both manifests, prove all declared skills resolve while the unused peer remains absent, reject peer imports from executable scripts, and exercise missing-CLI/bounded-root/retire hook behavior. The full acquire → lock → trust → activate → spawn probe remains pending released OAS 0.19.0 consumer fixtures.
