---
type: Reference
title: Repo state — the living picture of the OAS repo
description: Always-current snapshot of what is on main, what is in flight (PRs, features, running instances), recent deliveries, and open threads. Every oas-expert instance updates the relevant subsection whenever it changes that reality (merge, release, spawn, retire, delivery).
tags: [stewardship, repo-state, living]
timestamp: 2026-07-24
---

# Repo state — the living picture

Maintenance contract: **whoever changes this reality updates this concept in
the same session** — a maintainer instance that merges a PR or cuts a release
appends here before retiring; the steward instance keeps it honest. Newest
entries first inside each section; prune entries that stop being true rather
than letting the file grow stale.

## On main

- PR #19 merged 2026-07-24 as `9b39ee7`: OAS Desktop 0.1.0 private
  package now owns the panel backend; oas.web, `oas pane`, and the public
  control-pane export are retired with deterministic migration diagnostics.
  Explicit spawn lineage/task delivery landed with traversal-safe shared
  instance lookup (name syntax + realpath immediate-child containment).
  Desktop release is still blocked on installer distribution and replacing
  adjacent-core mutations with compatible installed-CLI JSON calls.

- 2026-07-23 reviewer-deaths incident fixes (direct commits, incident
  response): b3eeed0 — retireInstance tmux kill-window targets `=`-anchored
  (tmux targets prefix-match; test fixture "reviewer-1" was killing live
  reviewer-15c135c* windows); 0753b40 — `npm test` pinned to explicit globs
  (bare `node --test` recursed into agents/*/instances/*/work sibling
  checkouts, re-running stale unfixed suites) + CLI-subprocess spawn/retire
  tests export PI_AGENTS_TMUX_SESSION=oas-test-nosuch.

- Earlier oas.web and Control Pane deliveries remain in the delivery log and
  donor-soul knowledge as migration history; their product surfaces are no
  longer present on main.
- Framework source remains 0.17.6 pending a breaking successor release;
  private Desktop is 0.1.0. Capabilities at: oas.review 1.1.6, oas.okf 1.3.1,
  oas.aweb 1.5.1, oas.jira 1.0.0. Published artifacts remain on the prior
  release until the desktop distribution gate is satisfied.

## In flight

- `feature/desktop-dist` was cut at a154f0e on 2026-07-24. cli-dev-desktop-dist-2
  owns the CLI/version/npm slice on `cli-dev/desktop-dist`;
  oas-desktop-engineer-desktop-dist owns installers, app integration, pruning,
  and parity on `oas-desktop-engineer/desktop-dist`. The frozen target is one
  public `v0.18.0` tag publishing root/pi npm plus macOS arm64+x64 and Linux x64
  Desktop assets. Binding gates are in the [public release contract](/decisions/desktop-public-release-contract.md).

## Recent deliveries

- (record PR #, one-line scope, verdict, merge/close date)
- PR #19 Desktop ownership cut + legacy panel retirement + explicit spawn
  lineage/traversal hardening: MERGED 2026-07-24 after two RETURNs (see
  delivery-log).
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
  visible only via `aw mail inbox --show-all`. RESOLVED-as-characterized 2026-07-23: intermittent ~30-min
  delay when the recipient session is mid-turn (2 delayed while busy, 2
  prompt while idle); no drops observed. Reported to the human by
  tui-dev-desktop-shell. Triage: check `aw mail inbox --show-all` before
  assuming a retired sender died. Two data points at a consistent ~30-min
  offset (10:16→~10:4x, 10:23→~10:5x) suggest a fixed-period flush; operator
  report filed by tui-dev-desktop-shell with message-ids and timestamps.
  Fleet-facing lessons also promoted into tui-dev's soul knowledge. Escalated to the human operator via
  tui-dev-desktop-shell; triage guidance: window-gone + no-event now most
  likely means completed-but-event-dropped, check `--show-all` and the
  session log tail.
- Sibling agent worktrees predate the b3eeed0/0753b40 fixes; until they
  merge main, `npm test` run from THOSE roots can still prefix-kill live
  reviewer-* windows (owners notified via tui-dev thread).

- Org-level GitHub Actions policy blocks CI bump-PRs — manual rescue each
  release until an org admin relaxes it.
- Published artifacts still predate PR #19. Do not tag the breaking successor
  merely to close capability-version drift: desktop installers and the
  installed-CLI/no-CLI boundary are mandatory release prerequisites.
- webpanel-dev instance worktrees still hold deleted branches locally
  (webpanel-dev-1: feature/panel-refinements, fix/panel-key-routing,
  perf/fast-attach, debug/typing-live; webpanel-dev-spawn-from-panel:
  agents/webpanel-dev-spawn-from-panel — owners notified to clean up).
