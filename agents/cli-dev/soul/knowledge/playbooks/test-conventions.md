---
type: Playbook
title: Test conventions in test/capabilities.test.mjs
description: Kernel and CLI tests run node:test against temp directories with fixture souls, fake runtime binaries on PATH, and spawnSync of bin/oas.mjs for CLI behavior — follow these helpers instead of inventing new scaffolding.
tags: [testing, conventions, fixtures, cli, tmux]
timestamp: 2026-07-24
---

# The house style

All kernel/CLI behavior tests live in `test/capabilities.test.mjs`
(node:test + assert/strict). Run with `npm test`. Conventions:

- **Temp dirs**: `temp()` = `mkdtempSync(join(tmpdir(), "oas-cap-test-"))`;
  every test builds its whole world (repos, agents roots, configs) inside one.
- **`gitRepo(dir)`**: real `git init` + identity + initial commit — needed
  because spawn/worktree logic shells out to git.
- **`capability(repo, folder, manifest, files)`**: writes an owned package
  under `.agents/capabilities/owned/<folder>/oas.json` (with sane defaults:
  version, compatibility) plus any files.
- **`fixtureSoul(base, runtime, type)`**: a `dev` soul with soul.yaml,
  canonical AGENTS.md (with the CLAUDE.md symlink), instances dir, and a repo
  — returns `{ repo, root, soul, agent }`.
- **`fakeRuntimes(base)`**: writes executable no-op `pi` and `claude` shims
  and returns a PATH prefix — spawn tests never launch a real runtime; pass
  the PATH via env to the spawned process.
- **CLI behavior**: `spawnSync(process.execPath, [CLI, ...args], { cwd, env })`
  against `bin/oas.mjs` — test the actual command surface (init, install,
  spawn, retire, status), asserting on stdout/stderr and filesystem effects.
- Spawn probes in tests use `spawnInstance(..., { launch: false })`
  (scaffold-only) and inspect the created home.

# Gotchas

- Config-chain discovery needs an `oas-config.yaml` at the level — a lock or
  installed store alone is invisible (see the init-acquisition lesson).
- Team/cross-repo tests: build a workspace with a `team:` config and two
  member repos each holding `agents/` — this caught the "instance names only
  unique per agent dir" bug.
- Tests that reach real tmux must be idempotent against leftover session state.
  `oas okf harvest` launches a `memory-harvest-<slug>` tmux window in
  `PI_AGENTS_TMUX_SESSION`, so a fixed instance name can pass once and fail on
  rerun when that window still exists. Derive the instance name from the
  `mkdtemp` suffix and kill the launched window during cleanup.
