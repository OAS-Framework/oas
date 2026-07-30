---
type: Lesson
title: Clean-room tarball smoke must publish its own official package
description: Under catalog-first, oas init in the clean room resolves explicit official ids through the real catalog unless the room publishes and binds its own local official package.
tags: [release, clean-room, capability-materialization, oas-cli, testing]
timestamp: 2026-07-29
---

# The trap

`scripts/clean-room-smoke.mjs` runs `oas init --raw --knowledge oas.okf` from
the packed tarball. `--raw` only changes layer defaults; explicit `--knowledge`
still acquires. Under catalog-first, a cataloged official id resolves through
the published catalog, so the smoke was fetching `oas.okf@1.4.1` from GitHub on
each run.

A passing run did not prove hermeticity: a firewall-blocked release machine
would fail, and the failure would look like a packaging defect.

# Why the donor fix does not transfer

The donor commit `2a82f0f` bound an empty catalog so init fell back to the
bundled marketplace. That path is gone; catalog-first removed the bundled
fallback. An empty catalog now makes init fail cleanly, as pinned by
`test/classic-init.test.mjs` ("with an EMPTY catalog the official route is
unavailable and init says so instead of guessing").

# Current clean-room shape

The smoke publishes its own official package inside the clean room. It copies
the packed kernel's bundled `capabilities/oas-okf/` into
`oas-package/capabilities/oas-okf`, writes `oas-package.json`, commits that
package to a local Git repository, and points `OAS_PACKAGE_CATALOG` at a
room-local catalog entry.

This keeps the run offline while exercising the real materialization route from
the packed tarball. The locked `commit` should change on every run because it
comes from the room-local repo, not the published `d2bee61`.

# Probes it should keep

The smoke also asserts the fresh packed-kernel deployment shape:
`lockfileVersion: 2` with both required top-level maps, the capability row's
`package` back-reference, `trusted: false` on acquisition, no retired
package-row keys, a flat artifact under `.agents/capabilities/installed/`, no
`.agents/packages/`, the ignore file written, and `oas doctor` reporting no
`lockError`, no legacy lock, and no official migration.

See also [catalog-first classic init costs](/lessons/catalog-first-classic-init-costs.md),
[clean-room smoke exact skill baseline](/lessons/clean-room-smoke-exact-skill-baseline.md),
and [donor selective-port ledger](/references/donor-2a82f0f-selective-port-ledger.md).
