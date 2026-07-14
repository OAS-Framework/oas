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

## 1. Locate the OAS framework repository

Check a local pi package path, then likely locations such as
`~/oas`; verify with `git -C <dir> remote get-url origin`. Avoid
pi-managed git clones because updates reset them. If absent, ask where to
clone `https://github.com/OAS-Framework/oas`.

## 2. Spawn the expert against the user's repository

```bash
node -e "
import('<framework-repo>/lib/core.mjs').then(m => {
  const root = '<framework-repo>/agents';
  const a = m.findAgent(root, 'integrations-expert');
  const r = m.spawnInstance(root, a, {
    purpose: '<package-slug>',
    repo: '<users-workspace-or-repo>',
    work: 'checkout',
    task: '<capability intent; layer if any; skills/instructions/commands/hooks; external tools; desired global/group/soul targets; distribution path>',
  });
  console.log('window:', r.tmux.window, '| attach:', r.attach);
})"
```

The work tree is the user's repository, where a local package belongs under
`.agents/capabilities/<name>/`. A framework contribution belongs under
`capabilities/<name>/` in the framework worktree; an independently published
package uses its own repository.

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
