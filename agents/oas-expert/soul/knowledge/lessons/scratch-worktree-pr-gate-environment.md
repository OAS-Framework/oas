---
type: Lesson
title: Scratch-worktree PR gates need dependencies and installed capabilities
description: Running the full OAS repo gate in a fresh git worktree fails environmentally unless you install devDependencies and provide the deployment's installed capabilities.
tags: [pr-review, testing, worktree, gotcha]
timestamp: 2026-07-22
---

A maintainer validating a PR from a bare scratch worktree can hit environmental
failures that look like PR defects but are not:

1. `npm run validate` can crash with `ERR_MODULE_NOT_FOUND: ajv` because the
   worktree has the repository files but not `node_modules`. Run `npm install`
   in the worktree before running the gate.
2. The oas-web `/api/agents` test asserts that a capability-defined `reviewer`
   agent from `oas.review` is listed. That requires the deployment's
   `.agents/capabilities/installed/` directory to exist under the server's
   `--dir` root. A bare worktree only has the gitignored
   `.agents/capabilities/.gitignore` scaffold. Copy the deployment's
   `installed/` directory into the worktree's `.agents/capabilities/`, or run
   the test from the deployment root, before judging the test failed.

PR #14's scratch-worktree gate initially showed one failing test. With both
environment fixes, the full gate was 60/60 green.

# Related

- [OAS development team — PR-only flow, review capability, capability-defined agents, model preference lists](/decisions/dev-team-and-review-flow.md)
