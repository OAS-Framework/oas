---
type: Playbook
title: Release via tag-driven CI — never bump locally, probe the artifact
description: Releases are cut by pushing a vX.Y.Z tag on main which makes CI bump both packages and publish to npm, so local version bumps break the workflow and verification means installing the published artifact, not eyeballing the diff.
tags: [release, ci, npm, verification]
timestamp: 2026-07-21
---

# The flow (.github/workflows/release.yml)

Push tag `vX.Y.Z` on a commit reachable from `main` → CI verifies the tag is
on main, runs `npm version X.Y.Z` in the root and `packages/pi`,
syntax-checks all shipped `.mjs`, runs tests/pack checks, publishes
`@oas-framework/oas` and `@oas-framework/pi`, and pushes a
`release: vX.Y.Z [skip ci]` bump commit back to main. Requires the
`NPM_TOKEN` repo secret; `v*` tags are admin-restricted ("Bypassed rule
violations" on push is expected).

# Rules learned the hard way

1. **Never bump versions locally.** CI derives the version from the tag; if
   package.json already carries it, `npm version` fails with "Version not
   changed". package.json on main always shows the *previous* release when
   you tag.
2. **Probe the artifact, not the diff.** After CI goes green: fresh global
   install of the published version in a temp prefix, then exercise the new
   behavior end-to-end (e.g. for v0.12.0: cross-repo spawn from repo A homing
   in repo B, composed AGENTS.md correct, retire clean) and syntax-check the
   installed `.mjs`. Package smoke tests must cross the checkout boundary —
   a repo-local scaffold probe is not a substitute (pack tarballs, install in
   a clean external dir, run the installed CLI).
3. Release promptly after breaking config-shape changes: once live configs
   are migrated, the previously installed global kernel can no longer read
   them, and every `oas` command outside the checkout errors.

Fuller procedure: the `git-tag-release` skill in oas-expert's soul.
