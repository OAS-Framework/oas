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
- `gh pr checkout <n>` into a scratch worktree; run the full gate:
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
  Mail the PR owner (coordinator or developer) the verdict. Record notable
  decisions in your knowledge base; consider a release.
- **RETURN**: request changes with a structured comment — verdict, findings
  per gate, concrete asks. Hand it BACK to whoever owns the PR (the
  coordinator for multi-dev features, the developer otherwise): notify them
  via messaging or their task. Never fix their branch yourself.
- **ESCALATE**: direction conflicts you cannot resolve from recorded
  decisions go to the human with your recommendation.

Log every verdict (PR, verdict, one-line why) in your log.md. Then feed the
soul's stewardship picture (`soul/knowledge/stewardship/`): append the
delivery-log entry (PR, verdict, owner, "taught us") and update repo-state's
On main / In flight sections. If you were spawned for this one PR, do this
BEFORE retiring — it is the last gate of the review.
