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

- PR #13 merged 2026-07-22: oas.web 0.7.1 — 'cannot type' fix via logical
  pane key routing (window-level router, editable-control exclusion, Cmd-B
  vs Ctrl-B split), OASWEB_KEYROUTE regression test, webpanel-dev lesson
  concept.

- PR #12 merged 2026-07-22: oas.web 0.7.0 — terminal-unified input (no
  composer, no /api/send), adaptBg near-neutral truecolor-bg fold + themed
  ::selection, compact session header, collapsible sidebar + split panes.

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
  oas.web 0.7.1 (published marketplace carries review 1.1.2 and web 0.5.0
  until next tag).

## In flight

- PR #14 (oas-web 0.8.0 spawn-from-panel: /api/agents + /api/spawn, agentsRoot
  allowlist, no-task default spawn) — RETURNED 2026-07-22 for merge conflicts
  with main (post-#13 fork); gates 1–3 pass, owner
  webpanel-dev-spawn-from-panel resolving and re-requesting.

## Recent deliveries

- (record PR #, one-line scope, verdict, merge/close date)
- PR #14 oas-web 0.8.0 spawn-from-panel: RETURNED 2026-07-22 (mergeability
  only — conflicts with main; see delivery-log).
- PR #13 oas.web 0.7.1 logical key routing fix: MERGED 2026-07-22 (see
  delivery-log).
- PR #12 oas.web 0.7.0 panel refinements: MERGED 2026-07-22 (see
  delivery-log).
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
  0.7.1 — fold into next release/tag.
- webpanel-dev-1's instance worktree still holds deleted branches locally
  (feature/panel-refinements, fix/panel-key-routing — owner notified to
  clean up).
