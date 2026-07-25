---
type: Playbook
title: Test conventions in test/capabilities.test.mjs
description: Kernel and CLI tests run node:test against temp directories with fixture souls, fake runtime binaries on PATH, spawnSync of bin/oas.mjs for CLI behavior, and regression coverage at the layer where bugs occurred.
tags: [testing, conventions, fixtures, cli, regression, tmux]
timestamp: 2026-07-25
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

- Rejected spawn options need side-effect assertions, not only error assertions:
  after `spawnInstance` or the CLI rejects relation/anchor options, assert that
  no instance directory remains. See
  [kernel-validation-before-side-effects](/lessons/kernel-validation-before-side-effects.md).
- In `--json` CLI tests, spawn validation failures are stdout envelopes
  (`{ ok: false, error: { ... } }`), not stderr text. Parse stdout for stable
  error codes; reserve stderr assertions for non-JSON `die()` paths and JSON
  mode progress notes.
- Regression tests must exercise the layer where the bug lived. For CLI-surface
  bugs, spawn `bin/oas.mjs` with `spawnSync(...)` (for example `--work attached
  --relation unrelated --json`) and assert the CLI-visible effect, such as
  `parent === null`; a direct `spawnInstance()` test can stay green if the CLI
  regresses before calling the kernel. When cheap, temporarily reintroduce the
  original bug, confirm the test fails, then revert so the coverage has teeth.
- A clean checkout needs dependencies installed in both the repo root and
  `packages/desktop`; otherwise desktop tests can fail with missing transitive
  ESM packages such as `marked` before the kernel/CLI change under test runs.
- Config-chain discovery needs an `oas-config.yaml` at the level — a lock or
  installed store alone is invisible (see the init-acquisition lesson).
- Capability fixture packages under `.agents/capabilities/` are discovered only
  at config-chain levels; a bare git repo without `oas-config.yaml` can silently
  hide a fixture and turn the assertion into `E_UNKNOWN_COMMAND` instead of
  exercising manifest code.
- Team/cross-repo tests: build a workspace with a `team:` config and two
  member repos each holding `agents/` — this caught the "instance names only
  unique per agent dir" bug.
- Name-resolution tests need a local-soul fixture too. Local souls exercise the
  overlapping `listAgents(root)` plus `localAgentBases(root)` fallback path, so
  all-match lookup bugs can pass cross-repo tests while double-counting local
  homes; see [overlapping instance-home scans](/lessons/overlapping-instance-home-scans-dedupe.md).
- Tests that reach real tmux must be idempotent against leftover session state.
  `oas okf harvest` launches a `memory-harvest-<slug>` tmux window in
  `PI_AGENTS_TMUX_SESSION`, so a fixed instance name can pass once and fail on
  rerun when that window still exists. Derive the instance name from the
  `mkdtemp` suffix and kill the launched window during cleanup.
