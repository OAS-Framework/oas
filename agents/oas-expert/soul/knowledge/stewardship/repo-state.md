---
type: Reference
title: Repo state — the living picture of the OAS repo
description: Always-current snapshot of what is on main, what is in flight (PRs, features, running instances), recent deliveries, and open threads. Every oas-expert instance updates the relevant subsection whenever it changes that reality (merge, release, spawn, retire, delivery).
tags: [stewardship, repo-state, living]
timestamp: 2026-07-25
---
# Repo state — the living picture

Maintenance contract: **whoever changes this reality updates this concept in
the same session** — a maintainer instance that merges a PR or cuts a release
appends here before retiring; the steward instance keeps it honest. Newest
entries first inside each section; prune entries that stop being true rather
than letting the file grow stale.

## On main

- **RELEASED v0.18.3 (2026-07-25)** — corrected macOS installers. Tag `v0.18.3`
  on PR #27 merge commit `921f44a`. Published `@oas-framework/oas@0.18.3` +
  `@oas-framework/pi@0.18.3` (npm latest) and GitHub Release v0.18.3 with all
  six Desktop installers (mac arm64/x64 DMG+ZIP, linux x64 AppImage+DEB) +
  SHA256SUMS.txt + build provenance. Fixes the v0.18.2 defect: both mac `.app`
  bundles now carry COMPLETE ad-hoc signatures (identity `"-"`, NOT Developer ID,
  NOT notarized) and pass strict deep codesign, gated fail-closed in CI on both
  arches (external step + unconditional packaged smoke, byte-identical
  run-blocks). Manifests on main bumped to 0.18.3 via manual bump PR #28
  (`9a6eae8`) — the release run's own bump-PR create step is blocked by org
  policy (see open threads). v0.18.2 assets untouched. Operator to manually
  launch-test the released arm64 artifact.

- **PR #27 merged 2026-07-25 as `921f44a`**: publish valid ad-hoc-signed macOS
  installers (electron-builder `identity: "-"`; strict deep codesign gate as
  external workflow step + unconditional darwin smoke; release-notes existence
  gate; `CSC_FOR_PULL_REQUEST=true` on build-installers only). Drove v0.18.3.

- **PR #26 merged 2026-07-25 as `0061eb5`**: knowledge-only — promoted the
  detached-HEAD release refspec lesson
  (`agents/cli-dev/soul/knowledge/lessons/exact-tag-detached-head-refspec.md`)
  into the canonical cli-dev soul, harvested from PR #25's fix. No code change.

- **PR #25 merged 2026-07-25 as `8d7d2ee`**: release.yml bump-PR push ref
  fully-qualified to `HEAD:refs/heads/${BRANCH}` (detached-HEAD safe) + a
  regression guard in test/release-workflow.test.mjs. Fixes the recurring
  bump-PR push failure; no retag/republish (v0.18.2 stays complete).

- **RELEASED v0.18.2 (2026-07-25)** — first public OAS Desktop release.
  Tag `v0.18.2` on merge commit `7cc3b5b`. Published: `@oas-framework/oas@0.18.2`
  + `@oas-framework/pi@0.18.2` (npm latest), and GitHub Release v0.18.2 with all
  Desktop installers (mac arm64/x64 DMG+ZIP, linux x64 AppImage+DEB), SHA256SUMS
  + build provenance (UNSIGNED/not notarized — no signing secrets). desktopApi:1
  contract verified on the PUBLISHED artifact. Source manifests bumped to 0.18.2
  (root/pi/desktop) via manually-rescued bump PR #24. Delivered by PR #21 (the
  Electron app + legacy-panel succession, merged `0961175`) + PR #22 (Linux
  executableName release-blocker fix, merged `7cc3b5b`). Superseded the failed
  `v0.18.1` cut (Linux desktop-build failed, nothing published; tag deleted).

- PR #19 merged 2026-07-24 as `9b39ee7`: OAS Desktop private package took over
  the panel backend; oas.web, `oas pane`, and the public control-pane export
  retired with migration diagnostics; explicit spawn lineage/task delivery +
  traversal-safe shared instance lookup. (Its "release still blocked on installer
  distribution" caveat is now RESOLVED by v0.18.2.)

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
- Framework source is now **0.18.2** on npm (root/pi) with the first public
  Desktop installers on GitHub Release v0.18.2. Capabilities at: oas.review
  1.1.6, oas.okf **1.4.0**, oas.aweb 1.5.1, oas.jira 1.0.0. (Superseded the
  earlier "source remains 0.17.6 / published artifacts predate the desktop
  gate" state.)

## In flight

- **PR #29 RETURNED at `fb1f1bc` (2026-07-25)** — Desktop UX fixes (spawn
  probe retry; Shift+Enter/copyable transcript; repo→family roster + Instances
  stage; workspace tab restore). Direction/security and branch-local full gate
  pass. Fix required: the promised per-workspace roster sort currently uses one
  global localStorage key; add workspace-scoped restore/switch coverage. Branch
  also must merge current main (10 main-only v0.18.3 signing/release commits at
  verdict) and return with exact-head PR + installer checks green. Owner:
  dev-coordinator-parallel-2; maintainer oas-expert-pr29 remains alive.

## Recent deliveries

- (record PR #, one-line scope, verdict, merge/close date)
- PR #29 Desktop UX fixes: RETURNED 2026-07-25 at `fb1f1bc` for global-vs-
  per-workspace roster sort persistence and branch staleness; re-review pending
  (see delivery-log).
- PR #28 release: v0.18.3 manifest bump (manual bump-PR rescue for the release
  run's org-policy-blocked create step): MERGED 2026-07-25 (`9a6eae8`).
- PR #27 corrected macOS installers (complete ad-hoc signatures + strict
  codesign gate): MERGED 2026-07-25 (`921f44a`); drove the v0.18.3 publish
  (see delivery-log).
- PR #25 release.yml fully-qualify bump-PR push ref (detached-HEAD safe) +
  regression guard: MERGED 2026-07-25 (`8d7d2ee`); resolves the recurring
  bump-PR push failure (see delivery-log).
- PR #22 Linux executableName release-blocker fix + re-cut v0.18.2: MERGED
  2026-07-25 (`7cc3b5b`); drove the successful v0.18.2 publish (see delivery-log).
- PR #21 OAS Desktop standalone Electron app + legacy-panel succession: MERGED
  2026-07-24 (`0961175`); its `v0.18.1` release cut failed on the Linux build
  (nothing published), re-cut as v0.18.2 via PR #22 (see delivery-log).
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

- CI bump-PR step: the ambiguous-refspec failure is **RESOLVED on main** by
  PR #25 (`8d7d2ee`) and **confirmed on the v0.18.3 run** (push logged
  `[new branch] HEAD -> release-bump/v0.18.3`). The REMAINING cause is
  org-level: `gh pr create` fails `GraphQL: Resource not accessible by
  integration (createPullRequest)` because the OAS-Framework org policy blocks
  Actions-created PRs. Every tag-driven release therefore ends with a
  conclusion=failure run whose ONLY failed step is the bump-PR create; npm +
  GitHub Release already succeeded (never retag). Rescue each time: create +
  squash-merge the `release-bump/vX.Y.Z` branch manually (done for v0.18.3 as
  PR #28). Needs an org admin to relax the Actions-PR policy to fully automate.
  Rescue procedure is in the git-tag-release skill.
- Published artifacts are now v0.18.3 (RESOLVED — was v0.18.2). The corrected
  macOS installers ship complete ad-hoc signatures passing strict deep codesign;
  v0.18.2 assets remain untouched.
- webpanel-dev instance worktrees still hold deleted branches locally
  (webpanel-dev-1: feature/panel-refinements, fix/panel-key-routing,
  perf/fast-attach, debug/typing-live; webpanel-dev-spawn-from-panel:
  agents/webpanel-dev-spawn-from-panel — owners notified to clean up).
