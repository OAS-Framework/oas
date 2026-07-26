---
name: integration-authoring
description: >-
  Route custom OAS capability-package and integration work to the framework's
  integrations expert. Use when building, adapting, or debugging a reusable
  capability, new task/messaging/knowledge integration, oas.json manifest,
  lifecycle hook, or operational command—not merely activating an existing
  package. Triggers: "custom integration", "capability package", "integrate
  our tracker", "new messaging integration", "write an oas.json".
---

# Capability and integration authoring — delegate

A capability package may ship skills, instance instructions, requirements,
namespaced commands, and approved hooks. An integration is the constrained
subtype implementing exactly one fundamental layer. Building either requires
manifest, security, targeting-boundary, collision, and probe discipline; use
the framework's **integrations-expert** soul rather than improvising.

If the user only wants an existing package, use:

```bash
oas install <source>            # external acquisition + exact lock; inactive
oas trust <id>                  # only if commands/hooks exist
oas use <id> --global|--type <t>|--soul <s>
```

## 1. Verify the expert is available

Run `oas status` and confirm the deployment can resolve the `integrations-expert` soul. If it is absent, ask the human which OAS framework deployment owns reusable package work; never locate or import private kernel files.

## 2. Spawn the expert against the user's repository

```bash
oas spawn integrations-expert \
  --purpose <package-slug> \
  --repo <users-workspace-or-repo> \
  --work checkout \
  --task '<capability intent; layer if any; skills/instructions/commands/hooks; external tools; desired global/type/soul targets; distribution path>'
```

Use `--relation child --relative-to <your-instance>` only when the documented workflow makes the expert your child; otherwise leave the operator-origin spawn unrelated. The work tree is the user's repository, where a config-owned local package belongs under `.agents/capabilities/owned/<name>/`. A framework contribution belongs under `capabilities/<name>/` in the framework worktree; an independently published package uses its own repository.

## 3. Brief the design boundary

Tell the expert:

- whether it is additive or implements exactly one of knowledge/messaging/tasks;
- external requirements and executable surfaces;
- intended distribution and version/compatibility;
- desired config-owned targets and settings; and
- expected skill/instruction/scaffold collisions.

Targets never belong in the manifest. The expert must test exact pi/Claude
instance materialization, generated instructions, lock/trust behavior,
command gating, deterministic hooks, and scaffold ownership as applicable.

## 4. Hand off

Report the tmux window (`tmux attach -t pi-agents`). The expert follows its
package/integration craft, runs a scaffold-only probe, and leaves acquisition
and activation commands for the user. Its durable lessons harvest back into
its soul.
