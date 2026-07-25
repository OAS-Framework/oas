---
type: Lesson
title: Release workflow static tests pin sequencing by string position
description: A cheap, robust way to regression-test a GitHub Actions release workflow's binding ordering guarantees is a node:test file over raw YAML, but run-block extraction and wording guards need precise slices and documented historical exceptions.
tags: [release, ci, tests, workflow]
timestamp: 2026-07-25
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

# Mac installer verifier guards

For macos-correct-installers, `build-installers.yml` and `release.yml` both
needed the identical strict codesign verifier. When a static test asserts two
YAML `run: |` verifier blocks are byte-identical, slice from `run: |` to the
first blank line, not to the next `- name:`. The latter captures comments
preceding the next step, and those comments legitimately differ by workflow.
Slicing `text.indexOf("run: |", at)` to `text.indexOf("\n\n", runAt)` isolates
just the run-block. Mutation-check the guard by weakening either file's
codesign command or deleting one verifier step and confirming the test fails.

The macOS installer wording contract also forbids new claims that current
artifacts are "unsigned"; they are ad-hoc signed, not Developer ID signed or
notarized. A naive `/unsigned/i` guard also bans the verifier comment that
explains the historical v0.18.2 defect ("arm64 incomplete linker ad-hoc
signature; x64 shipped unsigned"). Strip that exact historical phrase before
testing for new `unsigned` wording so the past-tense defect description stays
writable while new incorrect current-artifact wording fails CI.
