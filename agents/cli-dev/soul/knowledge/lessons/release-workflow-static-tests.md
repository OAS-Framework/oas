---
type: Lesson
title: Release workflow static tests pin sequencing by string position
description: A cheap, robust way to regression-test a GitHub Actions release workflow's binding ordering guarantees is a node:test file asserting indexOf ordering and regexes over raw YAML, but script references still need spawned package-script tests.
tags: [release, ci, tests, workflow]
timestamp: 2026-07-24
---

# Lesson

For the v0.18.0 release seam, the contract demanded machine-checkable
evidence that release.yml (a) checks out the exact tag SHA, (b) bumps root,
pi, and desktop from the tag, (c) runs every build/smoke step before npm
publication, (d) creates the GitHub Release after npm, and (e) opens a bump
PR covering all three manifests. Instead of executing the workflow, a static
`test/release-workflow.test.mjs` reads the YAML as a string and asserts:

- `ref: ${{ github.sha }}` present and no `ref: main`;
- `yml.indexOf("npm publish") > yml.indexOf("publish:\n")` and
  `needs: [build-and-test, desktop-build]` — publication gated on builds;
- ordering via successive indexOf: publish oas → publish pi →
  `gh release create`;
- unsigned posture (`CSC_IDENTITY_AUTO_DISCOVERY: "false"`, no windows jobs).

This catches accidental reorderings in review-time edits without needing act
or a real tag. Keep step names stable — the tests key on them.

Static text assertions cannot prove that package scripts named by the workflow
exist. A workflow can pass YAML regex tests while invoking `npm test` or
`npm run dist` in a package that has no such script. Cover those references
with a test that actually spawns the package script, and mutation-check the
test before trusting it: break the script or script name and confirm the test
fails.
