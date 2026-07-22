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
