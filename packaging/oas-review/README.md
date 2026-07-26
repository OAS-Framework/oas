# oas-review

Official additive [OAS](https://github.com/OAS-Framework/oas) capability for fresh-eyes post-commit review. It contributes:

- a capability-defined, ephemeral `reviewer` agent;
- `code-review` and `security-review` skills; and
- developer instructions for commit review, maintainer escalation, and multi-developer delivery discipline.

The reviewer attaches read-only to the developer's worktree, reviews one named commit/range, sends a consolidated verdict to its parent through the configured messaging layer, and retires. It has no long-term memory by design.

## Requirements

The package has no host-command requirement and no command/hook executable surface. The reviewer operating loop currently delivers reports with `aw mail`, so deployments using the provided agent need a compatible messaging layer and `aw` available. The package remains additive and does not claim the messaging layer.

The final OAS compatibility floor is blocked on the package-engine freeze; see [`SCHEMA-STATUS.md`](SCHEMA-STATUS.md).

## Acquire and activate

Acquisition does not activate the capability. After an official release exists:

```bash
oas install oas.review --dir /path/to/scope
oas use oas.review --global --dir /path/to/scope
oas doctor /path/to/scope --soul <developer-soul>
```

A pinned Git source may be used after publication:

```bash
oas install git:https://github.com/OAS-Framework/oas-review.git@v1.1.7 --dir /path/to/scope
```

No `oas trust` step is needed because the manifest exposes only instructions, skills, and a capability-defined agent—no commands or lifecycle hooks. Targeting remains deployment-owned; use an agent type or soul binding instead of `--global` when only selected developers should receive the discipline.

After a substantive commit, the injected instructions launch a reviewer attached to the committing instance's worktree. Capability-defined agents resolve only where the deployment has declared this capability.

## Development

```bash
npm test
```

This validates both manifests, checks resource containment, and verifies the packaged reviewer/skill contract. The full acquire → lock → activate → spawn probe remains blocked on engine consumer fixtures.
