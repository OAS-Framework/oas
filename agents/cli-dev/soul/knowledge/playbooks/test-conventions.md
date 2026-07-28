---
type: Playbook
title: Test conventions in test/capabilities.test.mjs
description: Kernel and CLI tests run node:test against temp directories with fixture souls, fake/runtime tmux shims on PATH, spawnSync of bin/oas.mjs for CLI behavior, and regression coverage at the layer where bugs occurred.
tags: [testing, conventions, fixtures, cli, regression, tmux]
timestamp: 2026-07-28
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
  the PATH via env to the spawned process. For launched-path rollback tests,
  add a fake `tmux` that records its argv and exits 0 so launch succeeds
  without touching a real session.
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
- Cross-instance metadata-write failure tests need both failure forcing and
  rollback assertions: chmod the anchor `instance.json` to `444` and its
  directory to `555`, assert the throw plus no scaffolded home and unchanged
  anchor, then restore modes in `finally`. For the post-launch rollback branch,
  use a fake `tmux` shim that appends `$@` to a log and exits 0, force the
  atomic anchor write to fail by making the anchor home directory `555`, and
  assert `new-window`, exact-match `kill-window`, spawn+retire hook events, no
  zombie home, no temp leftover, and byte-identical anchor metadata. To prove
  cleanup continues when a cleanup step itself throws, pre-create a non-empty
  directory at the deterministic temp path so a naive temp unlink with
  `rmSync(..., { force: true })` fails, then assert the original error still
  surfaces and the later window, hook, scaffold, and anchor rollback assertions
  still pass. To prove tmux cleanup is effect-based rather than
  exit-code-based, use a stateful fake tmux: `new-window` appends to a window
  list file, `kill-window` filters the list, `list-windows` cats it, and an
  env-controlled stubborn branch returns success while leaving one launched name
  present. For a genuinely unremovable scaffold home, have a compensated retire
  hook create a read-only subdirectory (`mkdir` + `chmod 555`) inside the home
  before removal; then assert the incomplete-rollback diagnostic names the
  remaining home and that the home still exists. For git worktree cleanup
  truthfulness, have a compensated retire hook pin the worktree (read-only
  subdir plus `chmod 555` on `work/`) before removal, then assert the diagnostic
  names the remaining worktree/branch and the test verifies `git worktree list
  --porcelain` plus `rev-parse --verify --quiet refs/heads/<branch>` effects.
  For public ref/branch values in rollback probes, use a ref accepted by
  `git check-ref-format` that contains `$(touch${IFS}<marker>)`, assert the
  marker never appears, and exercise probe failures separately from absence;
  see [rollback probes](/lessons/rollback-probes-argv-and-fail-closed.md). To
  cover worktree canonicalization through rollback hooks, create the worktree
  through a symlinked agents root, have a compensated retire hook remove or make
  `work/` inaccessible before verification, use a delegating fake Git wrapper
  to make `git worktree remove` and prune cleanup fail while
  `worktree list --porcelain -z` still returns the stale canonical record, and
  assert rollback reports the retained canonical path rather than lexical
  fallback; see
  [canonical worktree verification](/lessons/canonical-worktree-verification.md).
  Restore modes in cleanup before deleting the temp tree. If the test replaces
  PATH wholesale, include symlinks for tools the kernel/hooks and shims still
  shell out to (`git`, `node`, `chmod`, `sh`, `grep`, `sed`, `mv`, `cat`,
  `printf`). See
  [cross-instance writes](/lessons/cross-instance-writes-commit-last.md).
- Every CLI-level `E_BAD_ARGS` relation-matrix case needs a direct
  `spawnInstance(..., { launch: false })` equivalent that passes the raw
  programmatic shape (for example dangling `relativeTo`, `unrelated` plus
  `relativeTo`, or `parent` plus `relation`) and asserts both the throw and no
  created home; CLI validation does not prove the exported kernel boundary.
- In `--json` CLI tests, spawn validation failures are stdout envelopes
  (`{ ok: false, error: { ... } }`), not stderr text. Parse stdout for stable
  error codes; reserve stderr assertions for non-JSON `die()` paths and JSON
  mode progress notes.
- Dedupe regressions must count the side effect being deduped, not only output.
  For package/capability restore dedupe, use a nested descendant topology under
  the lock's scope and a recording `cp` shim on `PATH` with a wrong-integrity
  lock so every retry is observable (copy, integrity failure, cleanup). A
  boundary plus one member can pass before the fix because it visits the lock
  only once anyway; shape the fixture so the pre-fix path attempts the same
  acquisition more than once.
- Regression tests must exercise the layer where the bug lived. For CLI-surface
  bugs, spawn `bin/oas.mjs` with `spawnSync(...)` (for example `--work attached
  --relation unrelated --json`) and assert the CLI-visible effect, such as
  `parent === null`; a direct `spawnInstance()` test can stay green if the CLI
  regresses before calling the kernel. When cheap, temporarily reintroduce the
  original bug, confirm the test fails, then revert so the coverage has teeth;
  do not use `git checkout <file>` to undo a temporary bug simulation in a file
  that also contains uncommitted work, because it discards both. Apply and
  reverse the simulation with exact edits or stash the real changes first.
- A clean checkout needs dependencies installed in both the repo root and
  `packages/desktop`; the desktop workspace has its own `package.json`,
  `package-lock.json`, and `node_modules`, so root install does not populate
  packages such as `jsdom` or `marked`. Run
  `cd packages/desktop && npm ci --ignore-scripts` before desktop tests. If a
  fresh worktree reports 17 `Cannot find package 'jsdom'` failures under
  `packages/desktop/test/`, baseline with a stashed clean run before blaming a
  kernel/CLI diff, and report the pre-existing gate gap honestly. In this
  harness, `cd` does not persist between tool calls, so run the install and
  verification in one command or set the working directory explicitly.
- Package-lock fixtures that contain intentionally fake scanner inputs
  (unreachable tarball URLs, bogus integrity, omitted dev/peer entries, etc.)
  are scanner-only fixtures: assert them by calling the exported scanner
  directly. Any lock used in an `npm ci` materialization test must be a valid,
  purely local closure (`file:` / `link: true` entries only), and portability
  checks should run with `npm_config_cache=$(mktemp -d)` so a warm local cache
  cannot hide CI-only failures.
- Config-chain discovery needs an `oas-config.yaml` at the level — a lock or
  installed store alone is invisible (see the init-acquisition lesson).
- Capability fixture packages under `.agents/capabilities/` are discovered only
  at config-chain levels; a bare git repo without `oas-config.yaml` can silently
  hide a fixture and turn the assertion into `E_UNKNOWN_COMMAND` instead of
  exercising manifest code.
- Symlink-containment walker tests should use a real `npm ci` `file:` dependency
  layout when validating package materialization: npm creates `node_modules/dep`
  as a relative symlink, and the security regression shape can require an
  inside symlink to a target directory that itself contains an escaping symlink.
  Keep recursive walk failures outside convenience `lstat` probe catches so
  escape errors propagate; see
  [symlink-containment walker throws](/lessons/symlink-containment-walker-throws.md).
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
