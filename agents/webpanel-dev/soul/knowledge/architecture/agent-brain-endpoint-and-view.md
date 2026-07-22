---
type: Concept
title: Agent brain endpoint and desktop brain view
description: GET /api/brain resolves agent names through kernel lookup seams, expands capability-agent skills from manifest leaf or parent-tree paths, returns only artifact paths, and feeds the desktop renderer's contract-based brain view.
tags: [brain, desktop-app, endpoint, renderer, capability-agents, skills]
timestamp: 2026-07-22
---

# Agent brain endpoint and desktop brain view

`GET /api/brain/<agent>?ws=<id>` (oas-web 0.9.0) resolves the agent name through the same kernel seams as spawn: `core.findAgent` first, then `core.findCapabilityAgent` for the workspace root. The caller cannot turn the agent name into a path probe; the route regex accepts only `[A-Za-z0-9._-]+` names, rejecting traversal-shaped names. Capability agents read the soul from `def._soulDir`, which is read-only in the package; local agents read `join(def._dir, "soul")`. Do not discover a capability-defined agent's canonical skills by walking `_soulDir/skills`: capability agents such as reviewers declare their skills in the owning capability manifest's `skills:` paths. Manifest entries can name either a leaf skill dir that contains `SKILL.md` or a parent tree of skill dirs, such as `skills: ["skills"]`; consumers must use `core.capabilitySkillDirs(def.capability, contextDir)` or an equivalent expansion that accepts both forms. The endpoint merges package-level skill dirs with any local `soul/skills` entries; local soul skills win duplicates rather than replacing the package set or being ignored.

The endpoint returns artifact locations as absolute paths only. Content display stays owned by viewer routes such as `/api/file`, which carry their own path guard. Skill artifacts are discovered as `<dir>/<skill>/SKILL.md` and summarized from `name`/`description` frontmatter through `core.parseFrontmatter`. The knowledge tree is a depth-capped markdown walk (depth 6) that skips dotfiles. Per-instance `running` comes from the roster snapshot's scoped `findInstance(name, ws?.id)`: when the caller resolved a workspace, the running-state lookup must stay within that snapshot workspace so same-named instances elsewhere cannot leak in. Instances absent from the scoped snapshot return `running:false` rather than erroring.

The desktop renderer view at `packages/desktop/renderer/views/brain.mjs` follows the desktop-app view contract: `mount(el, ctx)` and `unmount()`, all data access through `ctx.api()`, and every artifact click through `ctx.openFile(path)`. It guards against cross-agent render bleed during quick selection changes by accepting responses only when `sel.value === name && root`. Harness development happens in the SHARED `harness.html` (one tab per shipped view; the shipped-view enumeration is contract-tested), served by `harness-server.mjs` which proxies `/api/*` to the oas-web port on the same origin because oas-web sends no CORS headers. Standalone per-view harnesses are not kept — Brain's original `dev-brain.html`/`dev-serve.mjs` pair was consolidated into the shared harness on review.

# Test coverage lesson

A brain endpoint shape test that selects only a persistent/local agent can pass while capability agents still report `skills: []`. Regression tests for `/api/brain` must assert on at least one capability-defined agent so the `capabilitySkillDirs` path stays covered.

# Related

- [oas-web architecture](/architecture/oas-web-architecture.md) lists the endpoint in the server surface.
- [Scope snapshot lookups to the caller's workspace](/lessons/workspace-scoped-snapshot-lookups.md) records the running-state scoping trap.
