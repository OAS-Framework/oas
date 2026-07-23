---
type: Lesson
title: Bare node --test recurses into sibling agent worktrees
description: In an OAS repo that contains agents/*/instances/*/work, bare node --test discovers stale suites from sibling worktrees; pin explicit test globs and guard CLI subprocess tests with inert environment.
tags: [testing, node, worktree, oas, incident]
timestamp: 2026-07-23
---

During the reviewer-deaths incident (`oas-expert-reviewer-deaths`, main
`0753b40`), reviewer `r4` still died even though the tmux exact-target fix
(`b3eeed0`) was present in main and in the active worktree. The remaining
cause was the repo test script: bare `node --test` discovers tests by walking
the entire current working directory tree, excluding `node_modules` but not
OAS live-agent worktrees under `agents/*/instances/*/work`.

That meant the full test run executed stale copies of the suite from sibling
developer worktrees. Those stale suites still had a CLI-subprocess test that
called `retireInstance(root, "reviewer-1", {})` against the real `pi-agents`
tmux session, bypassing the fix in the current checkout.

Rules distilled:

- Do not use bare `node --test` as a repo-level script in an OAS checkout that
  contains agent worktrees. Pin explicit test roots or files, such as
  `test/`, `tests/`, `capabilities/`, or package-specific paths.
- For CLI-subprocess tests that could address real sessions, export an inert
  environment guard; the incident fix used
  `PI_AGENTS_TMUX_SESSION=oas-test-nosuch` as defense in depth.
- Treat test count inflation as a discovery leak. Seeing hundreds of passing
  tests when the real suite is much smaller means the runner is executing
  suites from places you did not intend.
- When a fix appears not to take, verify which checkout actually ran. A fixed
  active tree does not protect you if the runner discovered stale sibling
  worktrees for free.

This complements the [live cleanup scoping lesson](pkill-scoping-discipline.md):
even scoped destructive commands can become dangerous when an unscoped test
runner discovers stale copies of code that predate the scoping fix.
