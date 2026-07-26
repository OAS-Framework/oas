# oas-authoring

Official additive [OAS](https://github.com/OAS-Framework/oas) authoring guidance. This repository is the single canonical home of three Agent Skills:

- `integration-authoring` routes reusable capability/integration work to the framework's integrations expert;
- `skill-craft` teaches grounded Agent Skills design, triggering, evaluation, and maintenance; and
- `soul-craft` teaches concise durable soul operating docs and the boundary between always-loaded instructions, on-demand skills, and knowledge.

It claims no fundamental layer and contributes no commands, hooks, host requirements, or deployment policy.

## Requirements

A compatible OAS deployment must provide the `integrations-expert` soul for the delegation workflow. The skill uses the public `oas spawn` command; it does not locate or import private kernel files.

The frozen schema permits this flat capability-root declaration. The final OAS compatibility floor still awaits the lock-v2 release decision; see [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md).

## Acquire and activate

Acquisition does not activate the capability. After an official release exists:

```bash
oas install oas.authoring --dir /path/to/scope
oas use oas.authoring --global --dir /path/to/scope
oas doctor /path/to/scope --soul <authoring-soul>
```

A pinned Git source may be used after publication:

```bash
oas install git:https://github.com/OAS-Framework/oas-authoring.git@v1.0.0 --dir /path/to/scope
```

No `oas trust` step is needed because the manifest exports skills only. Targeting remains config-owned; activate for an authoring agent type or selected souls instead of globally when appropriate.

## Development

```bash
npm test
```

This validates both manifests, checks that all three skill paths are package-contained, validates skill frontmatter/name contracts, and rejects private-kernel import guidance. The full acquire → lock → activate → spawn probe remains blocked on engine consumer fixtures.
