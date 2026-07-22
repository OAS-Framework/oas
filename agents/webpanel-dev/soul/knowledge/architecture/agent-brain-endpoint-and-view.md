---
type: Concept
title: Agent brain endpoint and desktop brain view
description: GET /api/brain resolves agent names through kernel lookup seams, includes package-level skills for capability agents, returns only artifact paths, and feeds the desktop renderer's contract-based brain view.
tags: [brain, desktop-app, endpoint, renderer, capability-agents, skills]
timestamp: 2026-07-22
---

# Agent brain endpoint and desktop brain view

`GET /api/brain/<agent>?ws=<id>` (oas-web 0.9.0) resolves the agent name through the same kernel seams as spawn: `core.findAgent` first, then `core.findCapabilityAgent` for the workspace root. The caller cannot turn the agent name into a path probe; the route regex accepts only `[A-Za-z0-9._-]+` names, rejecting traversal-shaped names. Capability agents read the soul from `def._soulDir`, which is read-only in the package; local agents read `join(def._dir, "soul")`. Do not discover a capability-defined agent's canonical skills by walking `_soulDir/skills`: capability agents such as reviewers declare their skills in the owning capability manifest's `skills:` paths. The endpoint resolves those package-level skill dirs with `core.capabilitySkillDirs(def.capability, contextDir)` and merges them with any local `soul/skills` entries.

The endpoint returns artifact locations as absolute paths only. Content display stays owned by viewer routes such as `/api/file`, which carry their own path guard. Skill artifacts are discovered as `<dir>/<skill>/SKILL.md` and summarized from `name`/`description` frontmatter through `core.parseFrontmatter`. The knowledge tree is a depth-capped markdown walk (depth 6) that skips dotfiles. Per-instance `running` comes from the roster snapshot's `findInstance`; instances absent from the snapshot return `running:false` rather than erroring.

The desktop renderer view at `packages/desktop/renderer/views/brain.js` follows the desktop-app view contract: `mount(el, ctx)` and `unmount()`, all data access through `ctx.api()`, and every artifact click through `ctx.openFile(path)`. It guards against cross-agent render bleed during quick selection changes by accepting responses only when `sel.value === name && root`. `dev-brain.html` is a standalone harness that fakes `ctx` against a live oas-web server; because oas-web sends no CORS headers, run it through `packages/desktop/renderer/dev-serve.mjs`, which serves the renderer harness and proxies `/api/*` to the oas-web port on the same origin.

# Test coverage lesson

A brain endpoint shape test that selects only a persistent/local agent can pass while capability agents still report `skills: []`. Regression tests for `/api/brain` must assert on at least one capability-defined agent so the `capabilitySkillDirs` path stays covered.

# Related

- [oas-web architecture](/architecture/oas-web-architecture.md) lists the endpoint in the server surface.
