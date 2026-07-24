---
type: Concept
title: Agent brain endpoint and desktop brain view
description: GET /api/brain resolves agent names through kernel lookup seams, expands capability-agent skills from manifest leaf or parent-tree paths, returns only artifact paths, and feeds the desktop renderer's contract-based brain view.
tags: [brain, desktop-app, endpoint, renderer, capability-agents, skills]
timestamp: 2026-07-23
---

# Agent brain endpoint and desktop brain view

`GET /api/brain/<agent>?ws=<id>` (introduced in oas-web 0.9.0; now served by the bundled desktop backend) resolves the agent name through the same kernel seams as spawn: `core.findAgent` first, then `core.findCapabilityAgent` for the workspace root. The caller cannot turn the agent name into a path probe; the route regex accepts only `[A-Za-z0-9._-]+` names, rejecting traversal-shaped names. Capability agents read the soul from `def._soulDir`, which is read-only in the package; local agents read `join(def._dir, "soul")`. Do not discover a capability-defined agent's canonical skills by walking `_soulDir/skills`: capability agents such as reviewers declare their skills in the owning capability manifest's `skills:` paths. Manifest entries can name either a leaf skill dir that contains `SKILL.md` or a parent tree of skill dirs, such as `skills: ["skills"]`; consumers must use `core.capabilitySkillDirs(def.capability, contextDir)` or an equivalent expansion that accepts both forms. The endpoint merges package-level skill dirs with any local `soul/skills` entries; local soul skills win duplicates rather than replacing the package set or being ignored.

The endpoint returns artifact locations as absolute paths only. Content display stays owned by viewer routes such as `/api/file`, which carry their own path guard. Skill artifacts are discovered as `<dir>/<skill>/SKILL.md` and summarized from `name`/`description` frontmatter through `core.parseFrontmatter`. The knowledge tree is a depth-capped markdown walk (depth 6) that skips dotfiles. Per-instance `running` comes from the roster snapshot's scoped `findInstance(name, ws?.id)`: when the caller resolved a workspace, the running-state lookup must stay within that snapshot workspace so same-named instances elsewhere cannot leak in. Instances absent from the scoped snapshot return `running:false` rather than erroring.

The desktop renderer view at `packages/desktop/renderer/views/brain.mjs` follows the desktop-app view contract: `mount(el, ctx)` and `unmount()`, all data access through `ctx.api()`, and every artifact click through `ctx.openFile(path)`. It guards against cross-agent render bleed during quick selection changes by minting a fresh request generation for each selection and accepting success or error completions only through one ownership predicate that captures generation, mounted-ness, and selected name; see [Guard async render completions on both success and error paths](/lessons/guard-both-completion-paths.md). The workspace roster refresh keeps a separate request generation from per-selection loads, disables the stale selector while replacing its options, and may cancel in-flight selection loads without allowing a selection load to cancel the roster response; see [Split request generations by independently superseding request kind](/lessons/split-generation-counters-per-request-kind.md). Harness development happens in the SHARED `harness.html` (one tab per shipped view; the shipped-view enumeration is contract-tested), served by `harness-server.mjs` which proxies `/api/*` to the backend port on the same origin because the backend sends no CORS headers. Standalone per-view harnesses are not kept — Brain's original `dev-brain.html`/`dev-serve.mjs` pair was consolidated into the shared harness on review.

# Test coverage lesson

A brain endpoint shape test that selects only a persistent/local agent can pass while capability agents still report `skills: []`. Regression tests for `/api/brain` must assert on at least one capability-defined agent so the `capabilitySkillDirs` path stays covered.

# Related

- [desktop backend architecture](/architecture/desktop-backend-architecture.md) lists the endpoint in the server surface.
- [Scope snapshot lookups to the caller's workspace](/lessons/workspace-scoped-snapshot-lookups.md) records the running-state scoping trap.
- [Contract-test the shared desktop renderer harness against shipped views](/lessons/shared-renderer-harness-enumeration-test.md) records the shared-harness tab enumeration rule.
