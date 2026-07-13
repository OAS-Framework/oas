---
type: Lesson
title: Package smoke tests must cross the checkout boundary
description: A source-tree probe cannot prove npm files lists, bin links, or thin-adapter kernel resolution; pack and install both artifacts in a clean external directory.
tags: [packaging, ci, testing, adapters, pi, skills]
timestamp: 2026-07-11
---

A scaffold probe run from a repository checkout can pass while the published
artifact is broken: package `files` may omit a manifest, npm may not create the
expected bin link, or a thin adapter may resolve the checkout through an
environment override instead of its installed kernel.

The maintainable smoke boundary is: `npm pack` both packages, install the
resulting tarballs into a fresh directory outside the checkout, point the
adapter at that installed kernel, and run behavior through installed CLI/core
paths. For OAS this should include init/doctor, exact instance-local skill and
instruction composition, canonical soul immutability, retirement, and strict
clean-contract config behavior. Keep real network services outside deterministic
PR CI, but run a disposable real harness session from the same packed artifacts
when changing adapter/discovery behavior; scaffold assertions cannot prove the
harness actually loaded the selected resources.

For Pi adapter/resource probes, filesystem shape matters. A scaffold assertion
can see the expected entries in an instance's `.agents/skills/` while a real Pi
session sees no selected skills if those entries are directory symlinks; Pi
0.80.6 did not descend through such symlink entries during recursive skill
discovery. The robust packed-artifact contract is to materialize real
instance-local skill directories, then ask a real harness session to report the
selected instruction marker, a selected skill name, and the absence of an
unrelated ambient skill physically present in the workspace. Enable at least the
read tool for that report, because Pi omits the skills section when no tool can
load a skill body.

# Related

- [Deployment probes catch what static checks miss](/lessons/release-verification.md)
- [npm package export maps must expose package.json](/lessons/npm-package-exports-and-files.md)
