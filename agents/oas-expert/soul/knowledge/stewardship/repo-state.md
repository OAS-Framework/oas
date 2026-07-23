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

- 2026-07-23 reviewer-deaths incident fixes (direct commits, incident
  response): b3eeed0 — retireInstance tmux kill-window targets `=`-anchored
  (tmux targets prefix-match; test fixture "reviewer-1" was killing live
  reviewer-15c135c* windows); 0753b40 — `npm test` pinned to explicit globs
  (bare `node --test` recursed into agents/*/instances/*/work sibling
  checkouts, re-running stale unfixed suites) + CLI-subprocess spawn/retire
  tests export PI_AGENTS_TMUX_SESSION=oas-test-nosuch.

- PR #17 merged 2026-07-22: oas.web 0.8.1 — visible, instant typing (echo
  snap+burst client-side; server never collects — `oas-web.mjs collect`
  child-process roster snapshot every 3s), /api/keys debug/failure paths
  hardened to never expose payloads (keySendError + leak regression test);
  two webpanel-dev lessons promoted.

- PR #14 merged 2026-07-22: oas.web 0.8.0 — spawn-from-panel (/api/agents +
  /api/spawn, agentsRoot allowlist, no-task default spawn, CLI-parity
  capability-agent resolution, compat floor >=0.16.0 with regression test).

- PR #16 merged 2026-07-22: oas.web 0.7.2 — fast session attach (instance-
  registry 2.5s-TTL cache, single-round-trip paneInfo(), three-rung client
  attach: cached frame → 120-line tail → gen-guarded deep backfill), unit
  tests for both extracted blocks; webpanel-dev lesson concept promoted.

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
  oas.web 0.8.1 (published marketplace carries review 1.1.2 and web 0.5.0
  until next tag).

## In flight

- (none)

## Recent deliveries

- (record PR #, one-line scope, verdict, merge/close date)
- PR #17 oas.web 0.8.1 typing visibility/latency + /api/keys hardening:
  MERGED 2026-07-22 (see delivery-log).
- PR #16 oas.web 0.7.2 fast session attach: MERGED 2026-07-22 (see
  delivery-log).
- PR #14 oas-web 0.8.0 spawn-from-panel: MERGED 2026-07-22 after two
  mergeability-only RETURNs (main moved under the branch twice; see
  delivery-log).
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

- aweb channel awakening drops (2 consecutive repros 2026-07-23): verdict
  mail from short-lived reviewer identities delivered and marked READ
  server-side but no awakening injected into the recipient's idle session —
  visible only via `aw mail inbox --show-all`. UPDATE 2026-07-23: delayed ~30 min, not lost — a
  flush/reconnect sweep eventually delivers; live push path fails silently. Escalated to the human operator via
  tui-dev-desktop-shell; triage guidance: window-gone + no-event now most
  likely means completed-but-event-dropped, check `--show-all` and the
  session log tail.
- Sibling agent worktrees predate the b3eeed0/0753b40 fixes; until they
  merge main, `npm test` run from THOSE roots can still prefix-kill live
  reviewer-* windows (owners notified via tui-dev thread).

- Org-level GitHub Actions policy blocks CI bump-PRs — manual rescue each
  release until an org admin relaxes it.
- Marketplace oas.review 1.1.2 vs repo 1.1.3, and oas.web 0.5.0 vs repo
  0.8.1 — fold into next release/tag.
- Branch CI fails the /api/agents "reviewer is listed" test in bare
  checkouts (no .agents/capabilities/installed/) — pre-existing environment
  gap seen on PR #14 and #17 branch runs; needs a CI fixture or test guard.
- webpanel-dev instance worktrees still hold deleted branches locally
  (webpanel-dev-1: feature/panel-refinements, fix/panel-key-routing,
  perf/fast-attach, debug/typing-live; webpanel-dev-spawn-from-panel:
  agents/webpanel-dev-spawn-from-panel — owners notified to clean up).
