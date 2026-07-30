---
type: Reference
title: What was ported from the frozen donor 2a82f0f, and what was rejected
description: Ledger of the selective donor port for the capability-materialization CLI lane — two cases ported, one JSON field enriched, five donor assertions rejected as superseded.
tags: [capability-materialization, oas-cli, testing, donor]
timestamp: 2026-07-29
---

The donor is frozen at `2a82f0f`; its CLI work lives in `d8af8cd`
(`test/init-package-v2.test.mjs`, 12 cases). It was never merged, reset, or
deleted — read as evidence only. Its package-store paths, emitter and docs
assertions are invalid under the revised architecture.

# Ported

- **The 0.19.4 reproduction, restated as a doctor assertion.** The donor's
  case 1 buried it in a large fixture case; the bug it fixed was only visible
  from `oas doctor` one command after `oas init`, so it is now its own case:
  a deployment created seconds ago has no `legacyLockFiles`, no
  `officialMigration`, and the string `oas migrate` appears nowhere in either
  the JSON or the human report. **Idea taken, assertions rewritten** — the
  donor checked `.agents/packages/installed/<id>/oas-package.json` and
  `migrationResidue`, neither of which exists now.
- **The host-requirement consent case** (donor case 3). Ported as: the
  requirement is reported with who asked, why, the install hint and the one
  copyable `--accept-requirement` command; init runs none of it; and doctor
  still reports it afterwards, proving init changed nothing about the host.
- **The empty-catalog hermetic fixture idea** — already in this lane before
  the donor was read, kept because it is the same idea: bind
  `OAS_PACKAGE_CATALOG` to an empty catalog so a case exercises the offline
  route with no network and no real catalog.

# Product change the port forced

`oas init --json` reported requirements as `{capability, command, install}`
while the human run printed the `why` and the consent command. Same run, two
different sets of facts. The JSON row is now
`{capability, command, why, install, consentCommand}` — the agent-callable
boundary must not be poorer than the prose.

# Rejected

- **`requestedBy: [...]`** — the donor aggregated requirements across
  capabilities. This lane's rows are already per-capability (`capability`), so
  an array would restate the key.
- **`result.nextCommands`** — a donor-only field; this lane reports follow-ups
  as prose on stderr and structured rows in the envelope.
- **`layers.tasks.package`** (donor case 4, alias route) — the alias case is
  already covered here against the flat capability rows, where the provider is
  the capability row's `package` back-reference rather than a nested layer field.
- **"the bundled marketplace stays the fallback for capabilities this
  release's catalog cannot resolve"** (donor case 11) — **superseded by the
  catalog-first maintainer ruling**: there is no bundled-marketplace fallback.
  An unreachable source fails clearly and the outer journal rolls back.
- **Every package-store assertion** — `.agents/packages/installed/<id>/`,
  `packages[].capabilities`, `trustedCapabilities: []`, `depsIntegrity`,
  `manifest._packageDir`, `migrationResidue`, and
  `lock.capabilities === undefined` on a fresh init. All are the transitional
  shape the revised architecture rejects.
- **"the package-profile path is unaffected"** (donor case 12) — the profile
  API is retired.

See also [catalog-first classic init](/lessons/catalog-first-classic-init-costs.md),
[payload-root ownership diagnostics](/decisions/package-payload-root-contract.md),
and [diagnostic remedies are contracts](/lessons/diagnostic-remedies-are-contracts.md).
