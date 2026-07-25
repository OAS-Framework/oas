---
type: Reference
title: Delivery log — every PR that reached (or was returned from) the main gate
description: Append-only record kept by per-PR maintainer instances — PR number, scope, verdict per gate, merge or return, and anything the review taught about the codebase. The stewardship counterpart of git history — the WHY next to the what.
tags: [stewardship, deliveries, append-only]
timestamp: 2026-07-25
---

# Delivery log

Append-only, newest first. Every per-PR maintainer instance appends ONE entry
before retiring — merge or return, always. Format:

```
## PR #<n> — <one-line scope> (<date>)
- verdict: MERGED | RETURNED (+ short why per failed gate) | CLOSED
- owner: <instance> · coordinator: <instance or none>
- taught us: <anything the review revealed — codebase gotcha, process gap,
  decision that needs recording — or "nothing new">
```

Entries whose lessons grow beyond a line get promoted to lessons/ or
decisions/ and referenced from here.

---

## PR #32 — remove the out-of-scope Desktop Instances stage (2026-07-25)
- verdict: MERGED as merge commit `97f66c9` at exact head `69641c9` after one
  RETURN. Direction and security passed throughout. Round 1 returned because a
  delayed-spawn fallback still directed users to the deleted “Instances view”
  and the branch lacked current main. Round 2 points and regression-pins that
  path to the permanent sidebar roster, corrects stale stage-era comments, and
  contains main `d3b0e69`. Fresh final gate passed: root 376 tests + one
  intentional skip, check/check:pi/validate/strict OKF/pack/smoke, Desktop
  183/183, human live workspace verification, independent reviewer APPROVE,
  and all four exact-head GitHub CI/installer checks. Approval was recorded as
  a PR comment (shared account); expected-head merge succeeded. The remote
  branch was deleted manually because the owner's worktree holds it locally.
- owner: oas-desktop-engineer-roster-scope-rollback · coordinator:
  dev-coordinator-parallel-2
- taught us: a surface-removal inventory must cover user-visible fallback and
  recovery copy, not only imports, nav entries, modules, and CSS. A broad
  “operation failed truthfully” assertion can stay green while directing users
  to a destination the same PR deleted. Corrective source is on main but needs
  a new patch release; v0.18.4 artifacts remain immutable.

## PR #31 — v0.18.4 manifest bump rescue (2026-07-25)
- verdict: MERGED as squash commit `fda7498`. The tag-driven v0.18.4 release
  completed build/test, all three Desktop installer build+smoke legs, both npm
  publishes, provenance, and the GitHub Release before the known org policy
  blocked Actions from creating the bump PR. The workflow-created branch
  `release-bump/v0.18.4` contained exactly the five expected root/pi/Desktop
  manifest and lockfile changes (0.18.3→0.18.4); manual PR #31 restored the
  protected-main bump flow and deleted the branch.
- owner: oas-expert-release-desktop-ux · coordinator: dev-coordinator-parallel-2
- taught us: nothing new — this is the documented org-policy rescue path, and
  the fully qualified detached-HEAD push continued to work correctly.

## PR #29 (round 3) — Desktop UX fixes final merge (2026-07-25)
- verdict: MERGED as merge commit `b7203eb` at exact head `9736852`. All four
  gates PASS. The final branch contains current main `5aa596f`, preserves both
  PR #29 UX and PR #30 corrected-installer knowledge histories, is API-clean/
  mergeable, and passes Desktop OKF strict (74/0/0). Exact-head GitHub checks
  all SUCCESS: Node 22 test/validate/pack/smoke plus macOS arm64, macOS x64,
  and Ubuntu x64 installer legs. Round-2 scratch correctness gate already
  passed 379 tests + one intentional node-pty ABI skip, check/validate/pack.
  Approval recorded as a PR comment (shared GitHub account); merged with the
  expected-head guard; remote feature branch deleted.
- owner: dev-coordinator-parallel-2 · coordinator: dev-coordinator-parallel-2
- taught us: the final workspace-sort contract needs identity at both storage
  and transition boundaries — key preferences by canonical workspace ID and
  resync on explicit switch plus silent server adoption. Parallel same-soul
  harvests require an append-only log union immediately before final handoff.
  Release version is intentionally selected at the next coordinated release,
  not bumped in this feature PR.

## PR #29 (round 2) — Desktop UX fixes re-review (2026-07-25)
- verdict: RETURNED at exact head `23e3c71` for mergeability only. The round-1
  correctness ask is fully fixed by `9c7c5c6`: sort persistence is a
  canonical-workspace-ID map, resynced on explicit switch and silent adoption,
  with safe legacy/corrupt fallbacks and behavioral A→B→A coverage. Fresh full
  gate PASS: 379 tests pass + one intentional node-pty ABI skip; check/validate/
  pack pass; Desktop soul OKF strict 71/0/0. Direction/security remain PASS.
  Mergeability FAIL: PR #30 advanced `origin/main` after the branch's earlier
  main merge; GitHub reports DIRTY/CONFLICTING and `git merge-tree` reproduces
  the conflict in `agents/oas-desktop-engineer/soul/knowledge/log.md`. Author
  must merge latest main, union the append-only log, and return green exact-head
  PR + installer checks.
- owner: dev-coordinator-parallel-2 · coordinator: dev-coordinator-parallel-2
- taught us: same-soul feature and harvest PRs conflict even when product code
  is independent; final handoff must follow all parallel knowledge harvests and
  bind to current main immediately before merge.

## PR #30 — post-v0.18.3 corrected-installer knowledge harvest (2026-07-25)
- verdict: MERGED as merge commit `935d142` at exact head `a220a306`. Product
  direction, correctness, security, and mergeability PASS. Scope is 13 files,
  all under cli-dev or oas-desktop-engineer soul knowledge/skills; no product,
  release, manifest, or framework behavior changes. Strict repo OKF PASS across
  all 8 bundles (0 errors, 0 warnings). Independent merged-state reviewer
  `reviewer-a220a30` on required `github-copilot/claude-opus-4.8:high` APPROVED
  with no blockers/security findings; required CI green. Maintainer approval was
  recorded as a PR comment because the shared GitHub account cannot approve its
  own PR.
- owner: cli-dev + oas-desktop-engineer memory harvests · coordinator:
  dev-coordinator-1
- taught us: a knowledge-only integration still benefits from an exact-head
  merged-state review because security guidance can alter operator behavior.
  Here the aweb mismatch skill stayed safe: diagnostics are read-only, it bans
  ad hoc identity repair, and sensitive actions still require independent
  confirmation. The sole reviewer nit (updating a concept timestamp alongside
  an Update log entry) was harmless.

## PR #29 (round 1) — Desktop UX fixes: spawn/chat/roster/workspace tabs (2026-07-25)
- verdict: RETURNED at exact head `fb1f1bc`. Direction and security PASS;
  clean scratch full gate PASS (359 tests pass, one intentional node-pty ABI
  skip; check/validate/pack; Desktop soul OKF strict 71/0/0). Correctness FAIL:
  the PR promises per-workspace roster sort persistence, but
  `views/instances.mjs` reads/writes one global `oas.desktop.rosterSort` key,
  so A's choice leaks into B; asked for canonical-workspace scoping and an
  A→B→A regression. Mergeability FAIL: branch was 10 commits behind current
  main (`e1ea91c` vs merge-base `f453b3e`), including v0.18.3 Desktop signing/
  packaging changes; author must merge main and return a green combined head.
- owner: dev-coordinator-parallel-2 · coordinator: dev-coordinator-parallel-2
- taught us: persistence described as “per workspace” needs a cross-workspace
  switching regression; a one-workspace localStorage test can pass while the
  preference silently leaks across workspace identity. Release version remains
  a release-time choice, not a feature-PR bump.

## PR #27 — publish valid ad-hoc-signed macOS installers (2026-07-25)
- verdict: MERGED as merge commit `921f44a` — exact head `77b7ae4`. Corrected
  the v0.18.2 macOS installer defect (arm64 shipped an incomplete
  linker-generated ad-hoc signature → Gatekeeper "damaged"; x64 unsigned).
  Drove release **v0.18.3** (tag on `921f44a`).
- owner: (feature/macos-correct-installers) · coordinator: dev-coordinator-1
- gates: all four pass. `electron-builder.config.cjs` `identity: null → "-"`
  (complete ad-hoc bundle signature); afterPack documented to run BEFORE signing
  so the spawn-helper chmod lands inside the seal. Strict
  `codesign --verify --deep --strict --verbose=2` gated fail-closed both as an
  external workflow step AND unconditionally in `dist:smoke` on darwin
  (platform-only guard, no OAS_SMOKE_* can skip it), before artifact upload;
  the two workflow verifier run-blocks are enforced byte-identical by
  `test/release-workflow.test.mjs`. `CSC_FOR_PULL_REQUEST:"true"` on
  build-installers only (PR legs need it to actually sign; release.yml is
  tag-push so omits it) — safe, no signing secrets, deterministic ad-hoc.
  Release-notes existence gate added (fail fast pre-publish). New suites pass:
  codesign-verify 15/15, release-workflow 17/17. CI evidence (runs 30156699308
  + 30156539653, head 77b7ae4): arm64/x64 Signature=adhoc, Sealed Resources v2
  rules=13 files=179, node-pty packaged-ABI (x64 under Rosetta). Manifests stayed
  0.18.2 (tag-derived); no v0.18.2 asset mutation; Linux unaffected. Approve
  recorded as PR comment (same gh account). Remote branch deleted manually (dev
  worktree held the local branch).
- taught us: the release bump-PR step now fails ONLY on the org-policy cause,
  not the refspec — PR #25's `HEAD:refs/heads/<branch>` fix worked (push logged
  `[new branch] HEAD -> release-bump/v0.18.3`), then `gh pr create` failed with
  `GraphQL: Resource not accessible by integration (createPullRequest)` (org
  policy blocks Actions-created PRs). Rescue: publish was already complete
  (never retag) — created + squash-merged the bump PR manually (**PR #28**,
  main `9a6eae8`, manifests → 0.18.3). The release run shows conclusion=failure
  purely because of this final step; npm + GitHub Release succeeded. Until an
  org admin relaxes the Actions-PR policy, every tag-driven release needs this
  one manual bump-PR step.

## PR #26 — cli-dev soul: promote detached-HEAD release refspec lesson (2026-07-25)
- verdict: MERGED as merge commit `0061eb5` — knowledge-only, exact head
  `9f43317`. Lands the harvested lesson from cli-dev-desktop-dist-2's v0.18.2 /
  PR #25 work into the canonical cli-dev soul (its delivery branch was not
  merged directly, so a follow-up PR carried the soul update).
- owner: cli-dev-desktop-dist-2 (retired) · coordinator: dev-coordinator-1
- gates: OKF-correctness gate for a knowledge-only PR — strict validator PASS
  (19 concepts, 0 err/0 warn); one Lesson added
  (`lessons/exact-tag-detached-head-refspec.md`), indexed with description
  matching frontmatter, log newest-first; both referenced links resolve
  (release-workflow-static-tests.md, playbooks/release-tag-driven-ci.md); no
  unrelated changes (3 files, all under cli-dev soul knowledge). Approve
  recorded as PR comment (same-account GitHub block).
- taught us: nothing new — clean knowledge harvest; confirms the promote-lesson
  follow-up PR flow when a completed developer's delivery branch never merged.

---
- verdict: MERGED as merge commit `8d7d2ee` — all four gates PASS at exact head
  `e52826518`. Post-release one-line automation repair: the version-bump branch
  push in the publish job runs from a DETACHED HEAD (publish checks out
  `ref: github.sha`), where `git push origin "HEAD:${BRANCH}"` cannot infer
  `refs/heads/` and fails ("not a full refname") — the only red step of the
  v0.18.2 release, after all publication succeeded. Fix qualifies the
  destination to `HEAD:refs/heads/${BRANCH}` (+ explanatory comment). Direction:
  minimal, correct layer, no new contract surface. Correctness: guard VERIFIED —
  14/14 static release-workflow tests pass on the fix, and the new guard FAILS
  (not ok 7) when the ambiguous `HEAD:${BRANCH}` form is reintroduced. Security:
  push-destination refspec only — no trust-boundary/hook/order change. No
  retag/republish; v0.18.2 stays terminally complete.
- owner: cli-dev · coordinator: dev-coordinator-1
- taught us: nothing new on the codebase — this is the landed form of the fix
  the PR #22 delivery-log entry and repo-state open thread had already proposed
  (`HEAD:refs/heads/${BRANCH}`). The refined root cause is detached-HEAD ref
  inference (not only same-name-tag ambiguity); fully-qualifying the ref cures
  both. Approval recorded as a PR comment (same-account block), then merged.

## PR #22 — Linux executableName release-blocker fix + re-cut v0.18.2 (2026-07-25)
- verdict: MERGED as merge commit `7cc3b5b` — all four gates PASS at head
  `1a95e7e`. Fix VERIFIED on REAL green installer builds (build-installers
  run 30153115337, all 3 legs): ubuntu x64 AppImage(124MB)+DEB(96MB)
  built+smoke-verified, macos-14 arm64 DMG+ZIP, macos-14 x64 DMG+ZIP under
  Rosetta. `executableName: "oas-desktop"` (linux-scoped) + DEB
  `maintainer`/`homepage`. Complete 0.18.1→0.18.2 sweep; compat band
  unchanged. release.yml: fail-fast:false, macos-13 sunset runner dropped
  (x64 cross-builds on macos-14 under Rosetta).
- owner: oas-desktop-engineer-desktop-dist · handoff: oas-maintainer (verified);
  coordinator: dev-coordinator-1
- release: tag `v0.18.2` on `7cc3b5b` → run 30153347086 PUBLISHED
  `@oas-framework/oas@0.18.2` + `@oas-framework/pi@0.18.2` (latest) + GitHub
  Release v0.18.2 with all 7 assets (mac arm64/x64 DMG+ZIP, linux
  AppImage+DEB, SHA256SUMS + provenance). desktopApi contract verified on the
  PUBLISHED artifact: `oas version --json` == `{schemaVersion:1,...,version:"0.18.2",desktopApi:1}`.
  Manifest bump-PR (#24) manually rescued (CI step failed on an ambiguous
  `git push HEAD:release-bump/v0.18.2` refspec — tag v0.18.2 exists so the
  partial ref couldn't resolve; publish was already done). Orphan `v0.18.1`
  tag deleted post-green (operator OK).
- taught us: the tag-driven release's Linux/mac installer build can't be
  rehearsed pre-merge (tag must be on main), so a packaging-config defect
  (scoped-name AppImage executableName) survives the full local gate and
  fails only in a real release with nothing published — see
  [lesson](/lessons/release-ci-linux-build-unrehearsable-pre-merge.md). This
  PR also SHIPPED the structural gap-closer: a verify-only `build-installers.yml`
  (PR + workflow_dispatch, contents:read, fail-fast:false, own concurrency)
  that builds every installer leg on PRs without any publish surface. Also:
  the CI bump-PR push uses a partial refname (`HEAD:${BRANCH}`) that becomes
  ambiguous once the same-name tag exists — a real release.yml bug worth
  fixing to `HEAD:refs/heads/${BRANCH}` (proposed to human).

## PR #21 — OAS Desktop v0.18.x standalone Electron app + legacy-panel succession (2026-07-24/25)
- verdict: MERGED as merge commit `0961175` — all four gates PASS at head
  `975a44a`. Direction: matches decisions/desktop-public-release-contract in
  substance (installer matrix, Desktop CLI API v1, no-CLI observation mode,
  split ownership, dormant Diff/Jira removal, RETIRED_CAPABILITIES doctor
  diagnostics). Correctness: 333 pass/1 env-skip; check/validate/okf/pack/
  tarball-smoke green. Security: loopback+DNS-rebind+CSRF, terminal cap 20 in
  the owning main process, wx 0o600 task files, argv allowlist (execFile, no
  shell), realpath TOCTOU-hardened file-root guard, no kernel imports —
  strengthened, not weakened. Mergeability: CLEAN, 5 conflicts author-resolved,
  okf lock sha256-45c0… == oas.okf 1.4.0.
- owner: oas-desktop-engineer + cli-dev (multi-dev) · coordinator: dev-coordinator-1
- release fallout: the initial `v0.18.1` cut (0.18.0 already npm-published via
  #20 with no Desktop/desktopApi; idempotent skip-guard would skip a re-tag)
  FAILED at the Linux desktop-build — nothing published. Superseded by the
  operator-chosen `v0.18.2` re-cut (PR #22).
- taught us: independently verify the version-cut rationale against npm +
  GitHub Releases state, not just the coordinator's narrative — 0.18.0 was
  npm-only (no Release/installers), which is exactly why a fresh version was
  needed. A green PR gate + sound-looking release.yml is NOT proof the release
  publishes (see PR #22).

---

## PR #19 (round 3) — desktop succession + explicit spawn lineage (2026-07-24)
- verdict: MERGED as `9b39ee7` — all four gates PASS at exact final head
  `daa0b98`. Direction: desktop owns its backend and immediately retires
  oas.web, `oas pane`, and `lib/control-pane`; the adjacent-core bridge is
  explicitly release-blocking distribution debt, not a merge blocker.
  Correctness/security: fresh expanded gate, scaffold probe, ownership and
  lock checks passed; round-2 traversal was closed by generated-name syntax
  validation plus realpath immediate-child containment, with regressions for
  spawn-before-scaffold, retire-before-delete, canonical-soul survival, normal
  lookup, and an escaping symlink. Mergeability: exact-head GitHub CI green,
  current main ancestor, conflict-free merge-tree, and clean diff-check.
- owner: dev-coordinator-1 · coordinator: dev-coordinator-1
- taught us: a final handback is not final while reviewer nits are still being
  merged; bind approval to the actual PR SHA and exact-head check run. The
  release remains blocked until desktop installers and installed-CLI mutation
  boundaries are operational.

## PR #19 (round 2) — expanded desktop succession + explicit spawn lineage (2026-07-24)
- verdict: RETURNED — direction PASS against the amended immediate-cutover
  decision (direct-core bridge explicitly release-blocking debt); exact-head
  `047acbb` GitHub CI and scratch full gate green (234
  tests, one intentional ABI skip, all validation/pack/smoke), scaffold-only
  probe passed, ownership/removal/retirement diagnostics and lock integrity
  verified. Security/correctness FAIL: new shared `findInstanceHome(root, name)`
  accepts path traversal as an instance name. Reproduced `oas spawn dev
  --parent ../../dev/soul` accepting malformed lineage; the same helper powers
  retirement, and `oas retire ../../dev/soul` recursively deleted the canonical
  soul in an isolated probe. Author must reject separators/dot traversal,
  enforce immediate-child containment, and regress both spawn and destructive
  retire. Mergeability also has two `git diff --check` extra-blank-line errors.
- owner: dev-coordinator-1 · coordinator: dev-coordinator-1
- taught us: filesystem existence under `join(instancesDir, untrustedName)` is
  not identity validation; every instance-home lookup, especially destructive
  lifecycle callers, needs name validation plus resolved containment.

## PR #19 (round 1) — OAS Desktop transitional Electron app and oas.web bridge (2026-07-24)
- verdict: RETURNED — direction PASS against the accepted desktop succession
  decision; correctness/mergeability FAIL because required PR CI is red. The
  root test script now includes `packages/**/*.test.mjs`, but
  `.github/workflows/pull-request.yml` installs only root dependencies: 8
  desktop suites fail in a clean runner on missing `jsdom`/`marked` (187/196
  pass). Exact-head scratch gate after root + desktop installs reached 238/239;
  the remaining macOS node-pty prebuild-helper permission failure cleared with
  the README-required Electron rebuild, and the targeted real-wheel test then
  passed. Check/check:pi/validate/OKF/pack/smoke all passed. Owner asked to make
  CI install desktop dependencies, merge current main, and return a green
  exact-head gate.
- owner: dev-coordinator-1 · coordinator: dev-coordinator-1
- taught us: once a root test glob includes a private nested package that is
  not an npm workspace, root `npm ci` is not a complete CI environment; the
  workflow must install that package's lockfile too.

## PR #17 — oas-web 0.8.1 typing visibility + latency (echo snap+burst, off-thread roster snapshot) (2026-07-22)
- verdict: MERGED — all four gates green. Direction: right layer; the
  server-never-collects child-process snapshot is the correct fix for the
  single-threaded event loop; human-confirmed-on-dev-port process endorsed.
  Correctness: scratch-worktree gate 65/65 tests + check/validate/pack:check;
  OKF strict pass on the webpanel-dev bundle (two new lessons promoted).
  Security: /api/keys --debug logs metadata+byte-count only; keySendError
  shapes exec failures (exit status/signal only — e.message embeds hex-encoded
  keystrokes in argv) with a leak regression test. Approval recorded as PR
  comment (same-account block); merge-commit merge; remote branch deleted via
  `git push origin --delete` (webpanel-dev-1 worktree held it — owner notified).
- owner: webpanel-dev-1 · coordinator: none
- taught us: branch CI is red from a PRE-EXISTING environment gap — the
  /api/agents test expects the capability-defined 'reviewer' agent, but CI's
  bare checkout lacks .agents/capabilities/installed/; also failed on the
  PR #14 branch. Needs a CI fix or test guard (open thread). Also: on a
  single-threaded server, audit periodic exec*Sync handlers before tuning
  the hot path — tail latency, not median, was the felt lag.

## PR #14 (round 3) — oas-web 0.8.0 spawn-from-panel (2026-07-22)
- verdict: MERGED — all four gates green; approval again a PR comment
  (same-account block — applies to --request-changes too). Round-3 merge
  commit ea1f5b1 resolved the post-#16 four-file conflict exactly as asked:
  0.8.0 + >=0.16.0 floor kept, main's makeRegistryCache findInstance
  preserved untouched (zero main-side deletions) alongside the branch's
  agentsData()/spawnAgent(), soul index/log unions. Scratch-worktree gate:
  63/63 tests (OASWEB_KEYROUTE + #16 registry-cache/attach tests), check,
  validate, pack:check. Merge-commit merge (clean history); remote branch
  deleted via `git push origin --delete` (author worktree held it — owner
  notified).
- owner: webpanel-dev-spawn-from-panel · coordinator: none
- taught us: two consecutive pure-mergeability RETURNs on one PR confirms
  the staleness lesson (promoted to lessons/) — authors should re-check
  `mergeable` at handback; the author's round-2 resolution (verified
  adjacency by parse + live probe) is the standard we want. Release pending:
  marketplace oas.web 0.5.0 vs repo 0.8.0.

## PR #14 (round 2) — oas-web 0.8.0 spawn-from-panel re-review (2026-07-22)
- verdict: RETURNED again — gates 1–3 still PASS (no new branch commits
  besides the requested main merge 237d628, which resolved the PR #13
  conflicts exactly as asked); gate 4 FAIL: main moved under the branch —
  PR #16 (oas-web 0.7.2 fast attach) merged after 237d628, so the branch is
  CONFLICTING again in four files: oas.json (0.7.2/>=0.14.0 vs 0.8.0/
  >=0.16.0), bin/oas-web.mjs (registry-cache findInstance vs the branch's
  agentsData/spawnAgent additions — adjacent, both must survive), and
  webpanel-dev soul index.md + log.md (union). Author asked to merge main
  again, keep main's makeRegistryCache findInstance plus their additions,
  re-run the full gate, and re-check `mergeable` right before handback.
- owner: webpanel-dev-spawn-from-panel · coordinator: none
- taught us: with several PRs landing on one capability the same day, a
  returned PR can go stale between fix and re-review — advise authors to
  re-merge main immediately before handback, and consider sequencing
  same-capability PRs. `gh pr review --request-changes` hits the same
  same-account block as approve; the structured RETURN lives as a PR
  comment.

## PR #16 — oas-web 0.7.2 fast session attach: registry cache, single tmux round-trip, three-rung paint (2026-07-22)
- verdict: MERGED — all four gates green; approval again a PR comment
  (same-account block). Measured root cause was `findInstance()` rebuilding
  the whole control-pane model per `/api/session` request; fixed with a pure
  injectable 2.5s-TTL registry cache (`makeRegistryCache`), `paneSize` +
  `historySize` merged into one tmux `display-message` round-trip
  (`paneInfo`), and a three-rung client attach (cached-frame paint → 120-line
  tail → gen-guarded 2000-line backfill; `lines` in the render signature so
  the tail never suppresses the deep paint). Reviewer nits addressed in
  1555f2b via extracted marked blocks (OASWEB_REGCACHE, OASWEB_ATTACH) with
  unit tests. Full gate green in scratch worktree: 61/61, check, validate,
  pack:check. Remote branch deleted with `git push origin --delete` (author
  worktree held it locally — owner notified).
- owner: webpanel-dev-1 · coordinator: none
- taught us: round-trip count, not payload size, dominated attach latency —
  merging tmux queries and caching a rarely-changing roster beat any render
  optimization; the marked-block extraction pattern now covers server-side
  factories too (new Function over the extracted block), not just browser
  code. Release still pending: marketplace oas.web 0.5.0 vs repo 0.7.2.

## PR #14 — oas-web 0.8.0 spawn-from-panel: /api/agents + /api/spawn (2026-07-22)
- verdict: RETURNED — gates 1–3 (direction, correctness, security) PASS; gate 4
  (mergeability) FAIL: branch forked before PR #13 and conflicts with main in
  capabilities/oas-web/oas.json (version/description) and webpanel-dev's soul
  index.md. Full gate verified green in a scratch merge with main (60/60,
  check, validate, pack:check). agentsRoot allowlist (selector into server
  workspace roots) is a sound pattern; compat-floor regression test
  (core.* API → min kernel version map) is a keeper. Author asked to merge
  main, resolve the two conflicts, re-run the gate, and re-request.
- owner: webpanel-dev-spawn-from-panel · coordinator: none
- taught us: the /api/agents test needs the deployment's installed
  capabilities (.agents/capabilities/installed with oas-review) — a bare
  scratch worktree fails it environmentally; copy installed/ in (or run from
  the deployment root). Also: scratch worktrees need `npm install` before
  `npm run validate` (ajv devDep).

## PR #13 — oas-web 0.7.1 'cannot type' fix: logical pane key routing (2026-07-22)
- verdict: MERGED — all four gates green; approval again a PR comment
  (same-account block). Root-caused 0.7.0 regression: keydown bound to the
  term element and gated on DOM focus silently dropped keys after any
  header/toggle click. Fix routes via a window-level listener to the
  logically focused pane, excluding real editable controls; Cmd-B toggles
  sidebar, Ctrl-B always reaches the session (tmux prefix). New
  OASWEB_KEYROUTE marked block + node regression test (59/59); no change to
  /api/keys or the loopback POST guard; webpanel-dev OKF bundle --strict
  clean, new lesson concept recorded.
- owner: webpanel-dev-1 · coordinator: none
- taught us: DOM focus is too fragile a routing key for pane UIs — logical
  focus state plus an editable-control exclusion is the robust model; the
  marked-block extraction pattern (from PR #8) generalized cleanly to key
  routing. Remote branch deletion needed `git push origin --delete` because
  the author's worktree held the local branch.

## PR #12 — oas-web 0.7.0 panel refinements (2026-07-22)
- verdict: MERGED — all four gates green; approval again a PR comment
  (same-account block). Terminal-unified input (composer + `/api/send`
  removed), adaptBg near-neutral truecolor-bg fold with regression tests,
  compact `.phead` header, collapsible sidebar + split panes with per-pane
  state/gen guards; webpanel-dev OKF bundle validates --strict.
- owner: webpanel-dev-1 · coordinator: none
- taught us: removing an endpoint is a security win worth naming in review
  (smaller surface); per-pane generation counters are the clean pattern for
  multi-pane stale-response/key-leak guards. Release still pending — 0.7.0
  (and 0.6.0) unpublished until the next tag.

## PR #10 — webpanel-dev soul doc nits from PR #8 review (2026-07-22)
- verdict: MERGED — docs-only, both corrected claims verified against
  oas-web implementation (`capture-pane -p -e` without -J; server-side
  `\r\n?` → `\n` into load-buffer/paste-buffer -p); bundle passes OKF
  --strict. Approval again recorded as PR comment (same-account block).
- owner: webpanel-dev-1 · coordinator: none
- taught us: nothing new — the return-as-follow-up flow from PR #8 closed
  cleanly in one docs-only PR.

## PR #8 — oas.web 0.6.0 terminal-faithful session view (2026-07-22)
- verdict: MERGED — all four gates green; approval recorded as a PR comment
  (GitHub blocks same-account `gh pr review --approve`).
- owner: webpanel-dev-terminal-fidelity · coordinator: dev-coordinator-1
- taught us: zero-dep held under real pressure — the hand-rolled SGR
  renderer with a DOM-free marker block (`OASWEB_RENDERER_BEGIN/END`)
  extracted for node tests is a reusable pattern for testing browser-embedded
  logic without a bundler. New POST Host/Origin loopback guard hardens the
  panel's 127.0.0.1 posture against DNS rebinding. Two doc nits returned
  as follow-ups (stale `-J` reference, inverted paste-normalization claim
  in webpanel-dev's knowledge). Release needed to publish 0.6.0.

## PR #4 — session-error surfacing (2026-07-22)
- verdict: CLOSED — approved on quality, discarded by operator instruction
  before merge; branches deleted.
- owner: dev-coordinator-1 (multi-dev: tui-dev-1, webpanel-dev-1)
- taught us: first full multi-dev run; failure modes recorded in
  lessons/multi-dev-run-failure-modes.md and fixed in v0.17.0.
