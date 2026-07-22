---
type: Reference
title: Repo state — the living picture of the OAS repo
description: Always-current snapshot of what is on main, what is in flight (PRs, features, running instances), recent deliveries, and open threads. Every oas-expert instance updates the relevant subsection whenever it changes that reality (merge, release, spawn, retire, delivery).
tags: [stewardship, repo-state, living]
timestamp: 2026-07-22
---

# Repo state — the living picture

Maintenance contract: **whoever changes this reality updates this concept in
the same session** — a maintainer instance that merges a PR or cuts a release
appends here before retiring; the steward instance keeps it honest. Newest
entries first inside each section; prune entries that stop being true rather
than letting the file grow stale.

## On main

- PR #10 merged 2026-07-22: webpanel-dev soul doc nits from the PR #8
  review fixed (renderer -J claim, paste-normalization direction).

- PR #8 merged 2026-07-22: oas.web 0.6.0 terminal-faithful session view —
  hand-rolled zero-dep ANSI/SGR renderer, /api/keys raw passthrough,
  bracketed paste, POST Host/Origin loopback guard.
- v0.17.2 line: multi-dev coordination discipline (aweb-first per-commit
  reviewers, ephemeral service agents, lineage nesting), named TUI themes
  (dark/solarized) with palette isolation + tmux splits, skill-load mandates
  in all injections, coordinator maintainer-merge contract.
- Capabilities at: oas.review 1.1.3, oas.okf 1.2.2, oas.aweb 1.5.1,
  oas.web 0.6.0 (published marketplace carries review 1.1.2 and web 0.5.0
  until next tag).

## In flight

- (nothing)

## Recent deliveries

- (record PR #, one-line scope, verdict, merge/close date)
- PR #10 webpanel-dev doc nits: MERGED 2026-07-22 (see delivery-log).
- PR #8 oas.web 0.6.0 terminal-faithful session view: MERGED 2026-07-22
  (see delivery-log); two non-blocking doc nits returned to webpanel-dev
  as follow-ups.
- PR #4 session-error-surfacing: built + approved, then **discarded by
  operator instruction** 2026-07-22 (branches deleted; recoverable from the
  closed PR's commits if wanted).

## Open threads

- Org-level GitHub Actions policy blocks CI bump-PRs — manual rescue each
  release until an org admin relaxes it.
- Marketplace oas.review 1.1.2 vs repo 1.1.3, and oas.web 0.5.0 vs repo
  0.6.0 — fold into next release/tag.
