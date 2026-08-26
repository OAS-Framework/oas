---
type: Decision
title: The official catalog is remote — read from the OAS repo on GitHub
description: Founder decision (2026-08-26) — the official package catalog's source of truth is package-catalog.json on OAS-Framework/oas main, fetched at resolution time; the bundled copy is only an offline seed, and diagnostics never fetch.
tags: [packages, catalog, distribution, decision]
timestamp: 2026-08-26
---

# The official catalog is remote — read from the OAS repo on GitHub

## Context

Through v0.20.1 the official catalog was a file bundled inside the published
npm kernel, overridable only via `OAS_PACKAGE_CATALOG`. Catalog updates (new
official packages, repinned tags) were invisible to already-published kernels:
the v2.0.0 catalog activation merged to main was unreachable on 0.20.1 without
an env bridge. The founder rejected that shape outright (2026-08-26): "I don't
want to have the package catalog defined locally. It should just be like an
official packages file in the oas repo that is read directly from github."

## Decision

The catalog's source of truth is `package-catalog.json` at the root of
`OAS-Framework/oas` on `main`, fetched at catalog-resolution time from the
constant URL `https://raw.githubusercontent.com/OAS-Framework/oas/main/package-catalog.json`
(a module constant — never user, config, or lock input, so the kernel cannot
become a fetch proxy). Publishing or repinning an official package is now two
immutable-tag events: tag the package repo, update one line in the catalog on
main. No kernel release, nothing local.

Resolution order:

1. `OAS_PACKAGE_CATALOG` env override — operator-controlled file, REPLACE
   semantics, no fetch, no cache write; the hermetic escape hatch (tests,
   clean rooms, mirrors). Override files keep full freedom incl. `file://`.
2. Remote fetch — bounded (4s timeout, 1 MiB byte cap, https + GitHub-host
   final-URL check), shape- AND entry-validated as untrusted input (package
   id grammar, `https://`-only urls, canonical relative paths, safe refs),
   cached atomically per-user (0600 under `$OAS_HOME_DIR`, O_EXCL temp).
3. The last-successful cache — re-validated on read; a poisoned or corrupt
   cache is treated as absent.
4. The bundled seed — last resort, still shipped in the npm package.

Boundaries that do NOT move:

- The catalog stays identity/discovery only: it never grants executable
  trust and never advances a lock.
- Locked operations never fetch: bare restore/reconcile resolves ids from
  cache/seed offline; locks pin exact commits, so reproducibility is
  unaffected — only NEW acquisitions see catalog movement.
- **Diagnostics never fetch** (maintainer ruling, kernel precedent): `oas
  doctor` reports the current copy's provenance and age and names when a
  refresh happens; only acquiring commands with a bare catalog-id source
  refresh. `OAS_CATALOG_FETCH=off` is the documented air-gap switch.
- Format stays JSON (the kernel's minimal YAML reader is not the place for
  this file; the repo file is already the validated shape).

Shipped as v0.21.0 (pre-1.0 behavior change release); the Desktop CLI
acceptance band widened to `>=0.18.0 <0.22.0` in the same release.

## Consequences

- Already-published kernels before 0.21.0 still carry their frozen bundled
  catalogs; the env override remains their only bridge.
- The kernel gained its first steady-state network read. Offline behavior is
  explicit and tested: cache with a truthful staleness message, then seed.
- A hostile or MITM'd catalog payload is confined by entry validation and
  can at worst deny a fresh fetch (fall back to cache/seed) — it cannot
  redirect an official id to a non-https source or reach `git` argv.
