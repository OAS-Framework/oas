---
name: pr-review
description: Maintainer PR review for the OAS repo — review a pull request from the maintainer standpoint (correctness, product direction, security, mergeability) and either merge it or return it to the coordinator/developer with a verdict. Use when asked to review, approve, or merge a PR, or when a coordinator hands over a feature PR.
---

# Maintainer PR review

You are the maintainer: the last gate before main. Developers' commits were
already fresh-eyes reviewed (oas.review); your review is the one only you can
do — **is this the right change for OAS?**

## The four gates (in order — fail fast)

**1. Product direction.** Read the PR description, then the diff's shape
before its details. Does this belong in OAS, in this form?
- Check `soul/knowledge/` — decisions/, roadmap/, architecture/ — for the
  recorded direction. A PR that contradicts a Decision needs the decision
  amended FIRST (with the human), not silently overridden.
- Kernel additions: is this the minimal contract? New config keys, manifest
  fields, CLI flags, and hook env are forever — are they earned?
- Placement: kernel vs capability vs skill vs docs. Wrong-layer features
  bounce even when the code is good.

**2. Correctness.** Fetch and verify — never trust green checkmarks blind:
- Create the scratch clone/worktree first, run `gh pr checkout <n> --repo owner/name`
  with that scratch checkout as the process cwd (or use `git -C <scratch> fetch ...`
  plus a detached checkout), and verify both the shared checkout branch and the
  scratch `HEAD` before continuing. Before judging failures, run `npm install`
  there so validation can load devDependencies, and make sure oas-web tests whose
  server `--dir` is the scratch worktree can see the deployment's
  `.agents/capabilities/installed/` directory. Then run the full gate:
  `npm test`, `npm run check`, `npm run validate`, `npm run pack:check`.
- Read the diff completely. For kernel changes, check every consumer
  (adapter, capabilities, panel/TUI) for the changed surface.
- Tests: do new behaviors carry tests that would fail on regression?

**3. Security.** The maintainer lens, beyond the reviewer's pass:
- Trust boundaries the reviewer can't see: does this weaken acquisition
  integrity, trust-at-acquisition, hoisted-path containment, hook approval,
  or the localhost-only panel boundary?
- Anything that turns config/data into execution.

**4. Mergeability.**
- Branch up to date with main; conflicts resolved by the AUTHOR, not you.
- Commit messages truthful; docs/skills updated with behavior changes;
  capability versions bumped; memory files not leaking into the diff.
- Release impact: does this need a version cut after merge? Note it.

## Verdict and action

- **APPROVE + merge**: `gh pr review --approve`, merge (squash for messy
  histories, merge-commit for clean multi-dev features), delete the branch.
  Use the operational gotchas below when GitHub account sharing or another
  instance's worktree blocks the happy path. Mail the PR owner (coordinator or
  developer) the verdict. Record notable decisions in your knowledge base;
  consider a release.
- **RETURN**: request changes with a structured comment — verdict, findings
  per gate, concrete asks. Hand it BACK to whoever owns the PR (the
  coordinator for multi-dev features, the developer otherwise): notify them
  via messaging or their task. Never fix their branch yourself.
  **Then STAY ALIVE — you own this PR until it merges or closes.** Go idle;
  the owner mails you when fixes are pushed. On their "fixed" mail, re-run
  the affected gates on the new commits (full gate if the diff moved
  substantially) and merge or return again. You do not re-review from
  scratch: your prior findings and gate results are your working state
  (keep them in STATE.md). Retire only after the terminal outcome — merged,
  closed, or the human pulls you off.
- **ESCALATE**: direction conflicts you cannot resolve from recorded
  decisions go to the human with your recommendation.

Log every verdict (PR, verdict, one-line why) in your log.md. Then feed the
soul's stewardship picture (`soul/knowledge/stewardship/`): append the
delivery-log entry (PR, verdict, owner, "taught us") and update repo-state's
On main / In flight sections. If you were spawned for this one PR, do this
BEFORE retiring — it is the last gate of the review.

## Operational gotchas

- **The PR description is not the PR scope**: at the product-direction gate,
  compare the described feature area with the full merge range (`origin/main...HEAD`
  or GitHub's changed-files/commits view) before running expensive correctness
  and security gates. If the branch carries unrelated local, stewardship, or
  soul changes that are not already on GitHub `main`, return it for branch
  rebuilding or for those base commits to land through their own maintainer
  path first. See `knowledge/lessons/pr-branch-merge-range-scope.md`.
- **Green OKF commands can still hide producer warnings**: when a PR touches
  knowledge bundles, inspect `npm run validate:okf` output per bundle, not only
  the exit status or the final “Strict OKF validation passed” summary. Treat
  producer warnings in changed bundles, especially unreachable concepts, as
  navigation defects and require zero warnings before merging. See
  `knowledge/lessons/strict-okf-zero-exit-can-have-warnings.md`.
- **Strict OKF does not prove harvested knowledge is semantically current**:
  when a PR includes harvested soul knowledge from multiple feature branches,
  branch-union conflict resolutions, or cherry-picked terminal harvest commits,
  read the new and changed concepts for stale transitional claims. Ask whether
  each concept describes the final converged design, or clearly marks historical
  behavior as superseded and links to the superseding concept; do not let green
  code/tests plus strict OKF substitute for this semantic consistency check. For
  harvest cherry-picks, compare the source branch state at the original terminal
  harvest commit with the PR head for linked or relied-upon concepts, not only
  the cherry-picked final diff. See
  `knowledge/lessons/pr-review-knowledge-consistency-after-branch-union.md` and
  `knowledge/lessons/harvest-cherrypick-parent-state.md`.
- **Surface removals need user-guidance inventory**: when a PR removes a UI
  surface, stage, view, or destination, do not stop at imports, navigation
  entries, modules, and CSS. Search user-visible fallback/recovery copy, error
  paths, and tests for old destination labels; require assertions that pin the
  replacement destination instead of only proving a generic failure. See
  `knowledge/lessons/surface-removal-inventory-user-guidance.md`.
- **Window gone + no verdict does not always mean killed**: if a spawned
  reviewer/subagent's tmux window disappears and no verdict awakening arrives,
  run one targeted `aw mail inbox --show-all` and inspect the session log tail
  before diagnosing death. A verdict in all-mail history plus clean
  `aw mail send` / `oas retire --self` means completed-but-channel-fault;
  an abrupt mid-turn cutoff with no send/retire means externally killed. Do
  not replace live awakenings with polling loops. See
  `knowledge/lessons/window-gone-completed-vs-killed-triage.md`.
- **Bare `node --test` can run stale sibling worktrees**: `node --test` with no
  path arguments walks the whole current tree except `node_modules`. In OAS
  deployment roots, `agents/*/instances/*/work` are nested repo checkouts, so a
  bare test script can execute stale sibling suites. Treat suspiciously high
  test counts as a discovery-scope smell, and pin package test scripts to
  explicit globs. See
  `knowledge/lessons/bare-node-test-recurses-into-agent-worktrees.md`.
- **tmux target prefix matching can kill the reviewer**: tmux `-t session:window`
  targets prefix-match unless anchored; code or tests that exercise retire paths
  must use exact `=<session>:=<window>` targets, and tests must override the tmux
  session to a nonexistent name instead of touching the live default session.
  See `knowledge/lessons/tmux-target-exact-matching.md`.
- **`gh pr checkout --repo` still mutates cwd**: the `--repo owner/name` flag
  identifies the GitHub PR source, not the local checkout to update. For
  cross-repository reviews, create the scratch clone first, run checkout/fetch
  with that clone as cwd (or via `git -C <scratch>`), and verify both the shared
  checkout branch and the scratch `HEAD` before touching tests or mergeability.
  See `knowledge/lessons/gh-pr-checkout-repository-context.md`.
- **Bare scratch worktree false failures**: `npm run validate` needs installed
  devDependencies (for example `ajv`), and the oas-web `/api/agents` test needs
  the deployment's `.agents/capabilities/installed/` under the server `--dir`
  root so capability-defined agents such as `oas.review`'s `reviewer` are
  listed. Copy `installed/` into the worktree's `.agents/capabilities/`, or run
  the test from the deployment root. See
  `knowledge/lessons/scratch-worktree-pr-gate-environment.md`.
- **Conflict-only returns can re-conflict quickly**: when several PRs touch the
  same capability in one day, a branch returned only for merge conflicts can go
  stale again before re-review. Tell the author to re-merge `origin/main` and
  check `gh pr view <n> --json mergeable` immediately before handback; consider
  sequencing or fast-tracking re-review for same-capability stacks. See
  `knowledge/lessons/pr-return-staleness-fast-capability-cadence.md`.
- **A fix handback closes the maintainer's asks, not somebody else's list**:
  when independent reviewers and the maintainer report overlapping findings,
  preserve the maintainer's structured RETURN as the acceptance checklist and
  verify each ask against the exact delta. The owner's summary and parallel
  reviewer verdicts are evidence, not substitutes; superficially similar tests
  may prove different invariants (for example, two distinct symlink boundaries).
- **Final handback can be stale while reviewer nits are still landing**: a
  green exact SHA from the coordinator does not prove the merge head if an
  in-flight reviewer can still add a test-only fix or regression. Treat
  handback as final only after all reviewer-driven merges are settled; before
  verdict and merge, compare the PR API head, remote branch/ref, required check
  run's `headSha`, and the merge command's expected-head guard. See
  `knowledge/lessons/final-handback-requires-settled-reviewer-merges.md`.
- **Same GitHub account as PR author**: `gh pr review --approve` and
  `gh pr review --request-changes` can fail with the same-account GitHub block
  when the maintainer and author share the `gh` account. Record the APPROVE or
  RETURN verdict as a structured PR comment instead; for APPROVE, do not treat
  this as a failed review and continue to merge if the gates passed.
- **Branch held by another worktree**: `gh pr merge --delete-branch` can merge
  successfully but fail local branch deletion when a developer instance still
  has the branch checked out. Delete the remote with
  `git push origin --delete <branch>` and notify the worktree owner to clean up
  their local branch; do not switch, reset, or otherwise manage another
  instance's worktree for them. See
  `knowledge/lessons/pr-review-same-account-and-worktree-branch-delete.md`.
