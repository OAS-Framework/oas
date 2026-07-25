---
type: Lesson
title: No-CLI desktop server tests must hide the real oas CLI
description: Desktop server tests that expect cli-unavailable 503 must run the spawned server with an inert CLI environment, because an operator machine with a compatible installed oas binary can proceed past degradation and fail as a 409 domain error instead.
tags: [desktop, testing, cli-degradation]
timestamp: 2026-07-25
---

Running the repo-root gate (`npm test`) on an operator machine that has a
compatible `oas` CLI installed can make `test/desktop-server.test.mjs` ›
"/api/spawn validates" fail. The test asserts the mutation boundary degrades
with HTTP 503 and `cli-unavailable`, but the spawned desktop server's CLI probe
finds the real installed binary. The spawn attempt then runs and fails as a
domain error, observed as `409 !== 503`.

This was verified as pre-existing on a clean baseline of
`origin/feature/agent-relations` after `git stash`, so the failure is
environment-dependent rather than a code regression from the cluster work.

Tests that pin no-CLI degradation should give the spawned server an inert
environment, such as an emptied `PATH` or no persisted binary path, the same way
other CLI subprocess tests are guarded. Until the test is fixed, treat this
single failure as environmental when judging gate results on dev machines.

Related concepts:

- [Spawn endpoint root allowlist, empty-task semantics, and CLI-unavailable degradation](/architecture/spawn-endpoint.md)
- [Bare node --test recurses into sibling agent worktrees](/lessons/node-test-recursion-worktrees.md)
- [Fake CLI fixtures need absolute-path launchers under hostile PATH](/lessons/fake-cli-fixtures-hostile-path.md)
