---
type: Lesson
title: Prove an auto-merge preserved each side's delta instead of trusting silence
description: Git reporting "Auto-merging <file>" with no conflict is not evidence the other side's change survived; reverse-applying each side's post-base delta against the merged tree turns that into a checkable fact.
tags: [git, merge, integration, verification]
timestamp: 2026-07-27
---

# Lesson

Integrating a long-lived branch onto a moved `main` produces a handful of
files that Git auto-merges without a conflict. Silence there is not evidence:
it only means the hunks did not textually collide. A dropped or mis-placed
hunk from either side is exactly the failure an integration commit is supposed
to rule out, and reading the merged file does not scale past a few lines.

The cheap check is to reverse-apply each side's post-base delta against the
merged worktree:

```bash
base=$(git merge-base origin/main <branch>)
git diff "$base" origin/main -- <path> > /tmp/main.patch
git apply --check --reverse /tmp/main.patch   # succeeds iff that delta is fully present
```

`git apply --check --reverse` succeeds only if every line the patch adds is
present and every line it removes is absent in the current tree — i.e. the
delta is fully applied. It touches nothing (`--check`), so it is safe to run
on a dirty mid-merge tree. Run it once per side per file that auto-merged and
per file the other side owns; a failure names the exact hunk that went missing.

This caught nothing on the package-config integration (both `lib/core.mjs`
and `test/capabilities.test.mjs` deltas from `main`'s Claude launch fix were
fully present), but it converted "Git did not complain" into a reportable
verification, which is what a maintainer reviewing an integration head
actually needs.

# Related

Pairs with the adopt-then-adapt rule for sibling-owned shared suites in
[gate2-seam-teardown-execution](/lessons/gate2-seam-teardown-execution.md):
when a suite is adopted wholesale and re-adapted, the companion check is a
plain `diff` of the adopted file against its upstream original, where a small
reviewable line count (53 lines here) is the evidence that only the intended
adaptations were applied.
