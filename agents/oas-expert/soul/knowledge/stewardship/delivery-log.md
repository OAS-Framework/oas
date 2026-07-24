---
type: Reference
title: Delivery log — every PR that reached (or was returned from) the main gate
description: Append-only record kept by per-PR maintainer instances — PR number, scope, verdict per gate, merge or return, and anything the review taught about the codebase. The stewardship counterpart of git history — the WHY next to the what.
tags: [stewardship, deliveries, append-only]
timestamp: 2026-07-22
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
