---
type: Concept
title: Kernel/CLI split and the agents-root layout
description: lib/core.mjs is the runtime-neutral OAS kernel consumed by both the standalone CLI (bin/oas.mjs) and the pi extension adapter, and everything anchors on the closest agents/ root whose parent is the workspace.
tags: [architecture, kernel, cli, layout]
timestamp: 2026-07-21
---

# Shape

- `lib/core.mjs` (~1500 lines) is the **kernel**: souls & instances, config
  cascade, capabilities/marketplace, work modes, lifecycle hooks, team
  discovery, spawn/retire. It imports **no pi APIs** — it is consumed by both
  `bin/oas.mjs` (the standalone `oas` CLI) and `extension/index.ts` (the pi
  adapter). Anything runtime-specific belongs in the consumers, not the kernel.
- `bin/oas.mjs` is the CLI: command routing, argument parsing, the structural
  YAML editing of `oas-config.yaml` (it owns the `capabilities:` block and
  re-serializes it), init scaffolding, doctor.
- **Agents root**: `findRoot()` walks up from cwd (or `$PI_AGENTS_ROOT`) to the
  CLOSEST directory named `agents/`; its parent is the **workspace**, and soul
  `repo:` paths resolve relative to that workspace. `local-agents/` (legacy
  `tmp-agents/`) holds uncommitted agents in the same soul/ + instances/ shape.
- Per agent: `<root>/<agent>/soul/` is the canonical body (soul.yaml,
  AGENTS.md with CLAUDE.md → AGENTS.md symlink, skills/, knowledge/);
  `<root>/<agent>/instances/<inst>/` is a generated instance HOME (composed
  AGENTS.md, `soul` symlink, `work/`, TASK.md/STATE.md/log.md/notes/,
  instance.json).
- YAML parsing is a deliberate dependency-free subset (`parseYamlNested`):
  nested maps, inline arrays/maps, scalars — no anchors, no multi-line strings.
  Keep config shapes within what it supports.

Docs ground truth: `docs/implementation.md`, `docs/souls-and-instances.md`,
`docs/configuration.md` — read those before touching the kernel.
