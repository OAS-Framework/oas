---
type: Reference
title: Repo state — the living picture of the OAS repo
description: Always-current snapshot of what is on main, what is in flight (PRs, features, running instances), recent deliveries, and open threads. Every oas-expert instance updates the relevant subsection whenever it changes that reality (merge, release, spawn, retire, delivery).
tags: [stewardship, repo-state, living]
timestamp: 2026-07-26
---
# Repo state — the living picture

Maintenance contract: **whoever changes this reality updates this concept in
the same session** — a maintainer instance that merges a PR or cuts a release
appends here before retiring; the steward instance keeps it honest. Newest
entries first inside each section; prune entries that stop being true rather
than letting the file grow stale.

## On main

- **PR #44 merged 2026-07-26 as `479e8b5`** — Desktop split/sidebar UI completion follow-up to PR #41. Adds visible sidebar restore/toggle buttons and tab-strip split controls that dispatch through context-gated registered actions, proves splits seed from the active terminal tab, and aligns split member tabs in a dedicated full-width pane row by moving the real tab elements into per-pane groups while non-member tabs/controls stay below. Final exact head `f9e9ebb` passed prior full scratch gates plus final exact-head PR CI and all three installer checks after six mergeability-only RETURNs caused by concurrent stewardship/PR #45/#46 main movement. Same-account approval is PR comment `5085035759`; expected-head merge succeeded, and the remote feature branch was deleted manually after `gh pr merge --delete-branch` tripped on detached scratch branch detection. Post-merge scaffold-only child probe `oas-expert-pr44-probe` verified AGENTS/CLAUDE, soul/work links, memory scaffolding, real skills, child relation metadata, `launched:false`, and clean retirement. Not yet released.

- **PR #46 merged 2026-07-26 as `83ce16f`** — knowledge-only oas-desktop-engineer post-PR45 harvest. It preserves the maintainer-handback stewardship-race lesson and links it from crossed-mail coordination: named handback bases are minimums once `origin/main` advances, stale verdicts get one evidence-backed reply, explicit stop/hold instructions still win, and stewardship-only merge commits still receive the root gate. Final exact head `2551f1d` passed semantic review, scratch `npm test` 557/558 with the expected node-pty ABI skip, `check`, `validate`, `pack:check`, strict OKF for all 8 bundles with zero warnings (Desktop 108/0/0), diff-check, and exact-head CI. Same-account approval is PR comment `5085013285`; expected-head merge succeeded and the remote harvest branch is deleted. No product, release, manifest, package, or framework behavior changes.

- **PR #45 merged 2026-07-26 as `6f35e9e`** — Desktop post-spawn terminal handoff now waits for actual terminal readiness (`running && tmux.session`) under the existing ownership/composite-identity guards, closes the completed modal, degrades safely on timeout, and contains the whole quiet auto-open async flow so automated failures warn instead of blocking or escaping as unhandled rejections. Final exact head `9c4e995` passed the full local/scratch history and all four exact-head checks after four mergeability-only RETURNs caused by delayed crossed mail and concurrent stewardship moving main. Same-account approval is PR comment `5084986482`; remote branch deleted, owner retains local cleanup. Scaffold-only child probe `oas-expert-pr45-probe` verified expected layout, real skills, child relation metadata, no launch, and clean retirement. Not yet released.

- **PR #42 merged 2026-07-26 as `09605c7`** — knowledge-only oas-desktop-engineer quick-open harvest preservation. It carries the retiring `oas-desktop-engineer-quick-open` post-merge memory-harvest commit (`97654ce`, cherry-picked as exact PR head `028a984`) into the canonical soul: deferred module-level Quick Open preselects now explicitly die with the mounted Spawn consumer on unmount, updating both the pending-intent data-currency lesson and the Quick Open → Spawn preselect handoff decision. Final gates passed: targeted Desktop strict OKF `106/0/0`, aggregate strict OKF all 8 bundles with zero warnings, scratch `npm test` `554/555` with the expected node-pty skip after root + Desktop dependency install and copied installed capabilities, `check`, `validate`, `pack:check`, diff-check, and exact-head PR CI. Same-account approval was recorded as a comment; the remote harvest branch is deleted. No product, release, manifest, package, or framework behavior changes.

- **PR #41 merged 2026-07-26 as `c055614`** — Desktop terminal tabs now support bounded side-by-side and stacked split panes with existing tab identity/dedup, pane-level selection, adjacent-member close fallback, resize refits, editable shortcuts, and a pending-slot model kept in parity with the renderer. The sidebar is hideable with a persisted shortcut; non-mac `Ctrl+B` remains tmux-owned. Final exact head `2ff4792`; scratch gates, strict OKF for all 8 bundles, PR CI, and all three installer checks passed. Same-account approval was recorded as a comment; the remote feature branch is deleted, while local cleanup remains with the worktree at `/private/tmp/integrate-split-panels`. Not yet released.

- **PR #40 merged 2026-07-26 as `3da7ce8`** — Desktop Quick Open for souls (`Mod+P`) and terminal focus on user-initiated jumps. Adds shared overlay-picker machinery, fixes the palette fuzzy scorer's negative-prefix no-match bug, routes soul selection through Spawn's consumed-once `preselectSoul()` handoff, keeps `Ctrl+P` in Linux/Windows terminals shell-owned, and makes terminal content focus explicit via `activateTab(id, { focusContent })` plus a chordless `terminal.focusActive` action. Final exact head `9d00985`; scratch gates, strict OKF for all 8 bundles, PR CI, and all three installer verify jobs passed. Same-account approval was recorded as a comment; the remote feature branch is deleted. Not yet released.

- **RELEASED v0.18.6 (2026-07-26)** — tag `v0.18.6` on release-notes/stewardship commit `0dd7878`, containing PR #38 agent relations and PR #35 editable keybindings. Published `@oas-framework/oas@0.18.6` + `@oas-framework/pi@0.18.6` and GitHub Release v0.18.6 with all six Desktop installers, SHA256SUMS.txt, and build provenance. Release run `30198186842` passed build/test and macOS arm64/x64 plus Linux x64 installer build+smoke; its only failure was the known org-policy block on Actions-created PRs after publication. Manifests were bumped through manual rescue PR #39 (`9fc7c0e`). The published kernel passed syntax checks and a clean create→root-qualified child relation spawn→metadata/layout inspect→retire probe; canonical soul content stayed unchanged.

- **PR #38 merged 2026-07-26 as `dfa0ac0`** — explicit child/sibling/parent/unrelated spawn relations across kernel, CLI, and Desktop; ambiguity-safe root-qualified anchors; attached child-of-owner semantics; retirement splice repair; composite instance identity; cluster-first Active/sidebar surfaces; and a relation-aware spawn modal. The merge preserves PR #35 editable keybindings and PR #36 knowledge, with reviewed fixes for composite roster parent focus, hierarchy Brain selection, and modal shortcut ownership. Final exact head `4bbfe8d`; all local, strict OKF, PR CI, and three installer checks passed after two RETURNs. The remote feature branch is deleted. Scaffold-only child-relation probe `oas-expert-pr38-probe` verified expected layout, real skill directories, relation metadata, no launch, and clean retirement. The [spawn-relations decision](/decisions/spawn-relations-live-lineage.md) records the human-accepted no-journal/lease limitations. Released exactly as v0.18.6.

- **PR #36 merged 2026-07-25 as `032c7a3`** — knowledge-only oas-desktop-engineer post-PR35 keybindings harvests. Preserves both keybindings developers' stranded post-merge harvests: dispatch-ineligible view-action semantics, crossed-mail coordination, PR35 follow-up queues, modal focus restoration, and the DEFAULT_KEYMAP/defaultChord split plus terminal allowlist delivery follow-ups. Final exact head `1e9980f`; all local gates, strict OKF for all 8 bundles, PR CI, and mergeability passed after two maintainer RETURNs. The remote `harvest/keybindings-wiring` branch is deleted; local branch cleanup is blocked by another worktree at `/private/tmp/harvest-wiring`. No product, release, manifest, package, or framework behavior changes.

- **PR #35 merged 2026-07-25 as `7f1e5a7`** — Desktop user-editable
  keyboard shortcuts for all panel actions. Adds a central keybinding engine
  with localStorage overrides and sanitized explicit unbinds, a `Mod+,`
  shortcuts editor, action-id terminal allowlist interception before PTY writes,
  rebindable app/stage/tab/sidebar/terminal typography/view-local actions,
  full keyboard operation for roster/spawn/hierarchy surfaces, live chord labels
  and tooltips, and renderer syntax coverage. Final exact head `039458f`; all
  local gates, strict OKF for all 8 bundles, PR CI, and macOS arm64/x64 plus
  Linux x64 installer verify checks passed after two maintainer RETURNs. The
  remote feature branch is deleted; local branch cleanup is blocked by another
  worktree at `/private/tmp/integrate-keybindings`. Post-merge scaffold-only
  probe `oas-expert-pr35-probe` created the expected instance layout (AGENTS.md,
  CLAUDE.md, instance.json, STATE/log/notes, soul/work symlinks, .agents and
  .aw scaffolding) with `launched:false`, then retired cleanly. Released in
  v0.18.6.

- **RELEASED v0.18.5 (2026-07-25)** — corrective Desktop patch containing
  PR #32 and PR #33. Tag `v0.18.5` on `a0052bd` (both corrective merges plus
  release notes). Published `@oas-framework/oas@0.18.5` +
  `@oas-framework/pi@0.18.5` and GitHub Release v0.18.5 with all six Desktop
  installers, SHA256SUMS.txt, and build provenance. Release run `30160666617`
  passed build/test and macOS arm64/x64 plus Linux x64 installer build+smoke;
  its only failure was the known org-policy block on Actions-created PRs after
  publication. Manifests were bumped through manual rescue PR #34 (`8f5af90`).
  The published kernel passed a clean create→spawn→inspect→retire deployment
  probe; this machine's global kernel and Pi bridge were updated to 0.18.5 with
  clean OAS and LFX doctors. Per coordinator instruction, running Desktop app
  processes were not touched.

- **PR #33 merged 2026-07-25 as `595159e`** — fixes both remaining v0.18.4
  terminal field failures: Shift+Enter suppresses xterm keydown/keypress/keyup
  while writing one newline, and modifier-forced local xterm selection enables
  terminal copy with tmux mouse mode (Option on macOS, Shift on non-macOS).
  Final exact head `d75fa3a`; human live verification, local full/affected
  gates, strict OKF, required CI, and all three installer checks passed after
  two maintainer RETURNs. Released with PR #32 in v0.18.5; v0.18.4 remains
  immutable.

- **PR #32 merged 2026-07-25 as `97f66c9`** — corrective rollback for the
  out-of-scope PR #29 Instances rail destination and second roster sidebar.
  The shell again exposes only Active overview and Soul roster as stages; the
  permanent sidebar remains the instances context. The deleted stage/view,
  tests, docs, and 104 lines of stage-only CSS are gone, with absence pins;
  shared grouping helpers remain for separately owned sidebar work. Final exact
  head `69641c9`; full local gate, human live workspace test, independent
  reviewer, required CI, and all three installer checks passed. Released in
  v0.18.5; immutable v0.18.4 artifacts remain unchanged.

- **RELEASED v0.18.4 (2026-07-25)** — Desktop UX fixes from PR #29. Tag
  `v0.18.4` on `a84443a` (PR #29 merge plus release notes). Published
  `@oas-framework/oas@0.18.4` + `@oas-framework/pi@0.18.4` and GitHub Release
  v0.18.4 with all six Desktop installers (mac arm64/x64 DMG+ZIP, Linux x64
  AppImage+DEB), SHA256SUMS.txt, and build provenance. Build/test and all three
  installer build+smoke legs passed in release run `30158015741`; the run's
  only failure was the known org-policy block on Actions-created PRs after
  publication. Manifests were bumped to 0.18.4 through manual rescue PR #31
  (`fda7498`). The published kernel passed a clean create→spawn→inspect→retire
  deployment probe and reported Desktop API v1 at version 0.18.4. A human
  subsequently identified an out-of-scope Desktop navigation regression in
  PR #29. Corrective source landed in PR #32; v0.18.4 remains immutable and a
  new patch release is required (see open threads).

- **PR #29 merged 2026-07-25 as `b7203eb`** — Desktop UX fixes: spawn view
  retries an unsettled CLI probe with truthful pending UI; Shift+Enter inserts
  a newline and transcripts are copyable without Linux/Windows Ctrl-chord
  regressions; Instances is a first-class nav/palette stage with repo→family
  grouping, collapsible headers, and workspace-scoped sorting; active terminal
  tabs restore per workspace. Final exact head `9736852`; all PR and three-leg
  installer checks green. Released in v0.18.4.

- **PR #30 merged 2026-07-25 as `935d142`**: post-v0.18.3 knowledge-only
  harvest from cli-dev and oas-desktop-engineer. Promotes the corrected macOS
  installer signing/release lessons, strict codesign gate structure, release
  workflow/static-test gotchas, and a read-only aweb trust-mismatch diagnostic
  skill. No product, release, manifest, or framework behavior changes.

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
- Framework source and Desktop artifacts are now **0.18.6** (root/pi npm plus
  GitHub Release installers). Capabilities at: oas.review 1.1.7, oas.okf
  **1.4.0**, oas.aweb 1.5.1, oas.jira 1.0.0.

## In flight

- **README architecture narrative (2026-07-26)** — child `docs-expert-readme-architecture` is producing a draft-only positioning/outline/hero/term model/mixed-provider example and stale-claim audit against the accepted package architecture before any shared README edit. The intended thesis is provider-agnostic first-class specialist agents, curated per-agent OAS context, compounding expertise, mixed-runtime/model coordination, and runtime-agnostic fundamental-layer contracts. The founder resolved the wording/behavior gate through [strict instance curriculum](/decisions/strict-instance-curriculum.md): instantiation exposes only selected skills/injections while preserving provider-native tools/workflows. Current main still has ambient coexistence; cli-dev/package-engine is assessing whether strict Pi/Claude adapter parity lands as a later package-engine milestone or a separate dependent PR before the README/release.
- **Package-engine WS1 contract milestone (conditional freeze review 2026-07-26)** — `feature/package-engine@1db919b` merged the three contract artifacts from `cli-dev/package-engine@48fce06`; full gate passed (555 tests, check, validate, pack:check). Maintainer accepted the manifest/lock/source/store/per-capability-trust shapes for WS2 staging, but returned four pre-dependent-implementation clarifications: a documented versioned public package-runtime API for OKF (no private `lib/core.mjs` imports), operational package-local npm closure/integrity semantics for aweb, incremental transaction preservation of unrelated packages/trust, and runtime validation for one default profile plus trusted-capability subset. It also approved a temporary v2 read-only residue for explicitly migrated but not-yet-catalog-mappable v1 entries (transactional, collision-safe, no trust transfer, zero at cutover). Milestone 2 may continue on independent engine work; WS3 content push/probes remain frozen pending the amended contract head.
- **Distribution packages and official capability repositories (accepted 2026-07-26; implementation launched)** — [the accepted decision](/decisions/distribution-packages-config-profiles-and-requirements.md) defines an outer locked Git package that may ship multiple independently targetable capabilities and config profile snapshots, workspace-wide restore from an explicit team boundary, consented external-CLI installers, per-capability executable trust, and extraction of official capabilities into independent OAS-organization repositories. Three child coordinators are live: `dev-coordinator-package-engine` owns manifest/store/lock-v2/discovery/lifecycle/trust; `dev-coordinator-package-config` owns profile snapshots/team-boundary reconcile/consented requirements and waits for the frozen engine interface; `dev-coordinator-official-packages` owns the six-repository extraction/catalog/cutover and waits for the engine contract before publication. It created public README+MIT bootstrap `main` branches (no package content/tags/releases/catalog) in `OAS-Framework/oas-{okf,aweb,jira,linear,review,authoring}`, pushed never-merge staging branch `feature/official-packages-staging` from `109fa1368726`, and spawned child `integrations-expert-official-packages-staging` on `integrations-expert/official-packages-staging`; the engine coordinator has the concrete OKF runtime-API call inventory/freeze needs. Framework behavior has not changed yet.
- PR #46, PR #44, PR #42, PR #41, PR #40, PR #38, and the exact v0.18.6 release reached terminal outcomes; no delivery PR is currently active.

## Recent deliveries

- PR #44 Desktop split/sidebar UI buttons + active-tab split seeding + split-aligned tab strip: MERGED 2026-07-26 as `479e8b5`; final exact head `f9e9ebb`, remote branch deleted (see delivery-log).
- PR #46 oas-desktop-engineer maintainer-handback race harvest: MERGED 2026-07-26 as `83ce16f`; exact head `2551f1d`, remote branch deleted (see delivery-log).
- PR #45 Desktop spawn readiness handoff + modal close + quiet terminal open: MERGED 2026-07-26 as `6f35e9e` after four mergeability-only RETURNs; final exact head `9c4e995`, remote branch deleted, scaffold-only probe passed (see delivery-log).
- PR #45 Desktop spawn readiness handoff + modal close + quiet terminal open: RETURNED round 4 on 2026-07-26 at handed-back/API head `0b6853a` for mergeability only after PR #44 stewardship advanced main to `9ad504f` during handback (see delivery-log).
- PR #45 Desktop spawn readiness handoff + modal close + quiet terminal open: RETURNED round 3 on 2026-07-26 at handed-back/API head `f614be5` for mergeability only; it merged `627ffaa` but missed explicit successor `b5c9f3d` (see delivery-log).
- PR #45 Desktop spawn readiness handoff + modal close + quiet terminal open: RETURNED round 2 on 2026-07-26 at handed-back/API head `40938b8` for mergeability only; it merged `8191ea0` but missed explicit stewardship base `627ffaa` (see delivery-log).
- PR #45 Desktop spawn readiness handoff + modal close + quiet terminal open: RETURNED round 1 on 2026-07-26 at exact head `67d865c` for mergeability only; all other gates passed, waiting for a current-main merge and settled handback (see delivery-log).
- PR #44 Desktop split/sidebar UI buttons + active-tab split seeding + split-aligned tab strip: RETURNED round 6 on 2026-07-26 at live exact head `ad9ff4f` for mergeability/current-main only after PR #46 advanced main and made the PR conflicting (see delivery-log).
- PR #44 Desktop split/sidebar UI buttons + active-tab split seeding + split-aligned tab strip: RETURNED round 5 on 2026-07-26 at live exact head `abdbd28` for mergeability/current-main only; handback prose named stale `ff64caa`, and live branch missed `abd60d1`/`8d5dba5` PR45 stewardship on main (see delivery-log).
- PR #44 Desktop split/sidebar UI buttons + active-tab split seeding + split-aligned tab strip: RETURNED round 4 on 2026-07-26 at live exact head `07d714c` for mergeability only after PR #45 landed and introduced a Desktop knowledge-log conflict; same-head approval comment is superseded (see delivery-log).
- PR #44 Desktop split/sidebar UI buttons + active-tab split seeding + split-aligned tab strip: RETURNED round 3 on 2026-07-26 at exact head `4b91095` for mergeability/current-main only; it merged `b5c9f3d` but missed explicit successor `9ad504f` (see delivery-log).
- PR #44 Desktop split/sidebar UI buttons + active-tab split seeding + split-aligned tab strip: RETURNED round 2 on 2026-07-26 at exact head `defa48d` for mergeability/current-main only; product/correctness/security and all local/CI/installer gates passed (see delivery-log).
- PR #44 Desktop split/sidebar UI buttons + active-tab split seeding + split-aligned tab strip: RETURNED round 1 on 2026-07-26 at exact head `8836882` for product/diff-shape scope failure (see delivery-log).
- PR #42 oas-desktop-engineer quick-open deferred-intent harvest: MERGED 2026-07-26 as `09605c7`; exact head `028a984`, remote branch deleted (see delivery-log).
- PR #41 Desktop split panes + hideable sidebar: MERGED 2026-07-26 as `c055614`; exact head `2ff4792`, remote branch deleted (see delivery-log).
- PR #40 Desktop Quick Open for souls + terminal focus on user jumps: MERGED
  2026-07-26 as `3da7ce8`; exact head `9d00985`, remote branch deleted
  (see delivery-log).
- PR #39 release: v0.18.6 manifest bump (manual rescue after complete
  publication): MERGED 2026-07-26 as `9fc7c0e` (see delivery-log).
- PR #38 spawn-time agent relations across kernel, CLI, and Desktop: MERGED
  2026-07-26 as `dfa0ac0` after two RETURNs; exact head `4bbfe8d`, remote
  branch deleted, scaffold-only relation probe passed, v0.18.6 release pending
  (see delivery-log).
- PR #38 round 2 spawn-time agent relations: RETURNED 2026-07-26 for
  mergeability only at `df2e575`; all other gates and exact-head checks pass,
  but a previously launched maintainer harvest advanced main after handback
  (see delivery-log).
- PR #38 spawn-time agent relations across kernel, CLI, and Desktop: RETURNED
  round 1 on 2026-07-26 for knowledge correctness and mergeability at
  `e3f7401`; executable/security gates passed (see delivery-log).
- (record PR #, one-line scope, verdict, merge/close date)
- PR #36 oas-desktop-engineer post-PR35 keybindings harvests: MERGED
  2026-07-25 as `032c7a3` after two RETURNs; remote branch deleted
  (see delivery-log).
- PR #36 round 2 oas-desktop-engineer post-PR35 keybindings harvests: RETURNED
  2026-07-25 for mergeability only after correctness/security/full gates passed
  at `617241c` (see delivery-log).
- PR #36 round 1 oas-desktop-engineer post-PR35 keybindings harvest: RETURNED
  2026-07-25 for missing semantic parent harvest `5543ac5` (see delivery-log).
- PR #35 Desktop user-editable keyboard shortcuts for all panel actions: MERGED
  2026-07-25 as `7f1e5a7` after two RETURNs; remote feature branch deleted
  (see delivery-log).
- PR #35 round 2 Desktop keybindings: RETURNED 2026-07-25 for mergeability
  only after all code/knowledge/security gates passed at `b5651b6`; branch must
  merge latest main (see delivery-log).
- PR #35 round 1 Desktop keybindings: RETURNED 2026-07-25 for one
  knowledge-correctness fix after all code/security/mergeability gates passed
  (see delivery-log).
- PR #34 release: v0.18.5 manifest bump (manual rescue after complete
  publication): MERGED 2026-07-25 (`8f5af90`; see delivery-log).
- PR #33 Desktop Shift+Enter whole-chord suppression + modifier-forced terminal
  copy selection: MERGED 2026-07-25 as `595159e` after two RETURNs; released
  with PR #32 in v0.18.5 (see delivery-log).
- PR #32 Desktop Instances-stage scope rollback: MERGED 2026-07-25 as
  `97f66c9` after one correctness+mergeability RETURN; released with PR #33 in
  v0.18.5 (see delivery-log).
- PR #31 release: v0.18.4 manifest bump (manual bump-PR rescue after complete
  publication): MERGED 2026-07-25 (`fda7498`; see delivery-log).
- PR #30 post-v0.18.3 cli-dev/Desktop knowledge and skill harvest: MERGED
  2026-07-25 (`935d142`); strict OKF passed all 8 bundles (see delivery-log).
- PR #29 Desktop UX fixes: MERGED 2026-07-25 as `b7203eb` after one
  correctness+staleness RETURN and one mergeability-only RETURN; released in
  v0.18.4 (see delivery-log).
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
  PR #28, v0.18.4 as PR #31, v0.18.5 as PR #34, and v0.18.6 as PR #39). Needs an org admin to
  relax the Actions-PR policy to fully automate.
  Rescue procedure is in the git-tag-release skill.
- Published artifacts are now v0.18.6. The macOS installers retain complete
  ad-hoc signatures passing strict deep codesign; earlier release assets remain
  untouched.
- webpanel-dev instance worktrees still hold deleted branches locally
  (webpanel-dev-1: feature/panel-refinements, fix/panel-key-routing,
  perf/fast-attach, debug/typing-live; webpanel-dev-spawn-from-panel:
  agents/webpanel-dev-spawn-from-panel — owners notified to clean up).
