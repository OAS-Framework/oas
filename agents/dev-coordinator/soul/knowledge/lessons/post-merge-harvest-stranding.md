---
type: Lesson
title: Post-merge developer harvests land on instance branches — preserve before retiring
description: A developer's final oas okf harvest after the feature PR merged commits to their instance worktree branch, which retirement deletes; verify with merge-base and cherry-pick the harvest commits onto a knowledge-only PR before oas retire --delete-branch.
tags: [retirement, harvest, okf, coordination]
---

# Post-merge harvests strand on instance branches

When a developer runs `oas okf harvest` after the feature PR has merged, the harvest commit lands on their instance worktree branch — not on main and not on any delivery branch. `oas retire --delete-branch` would delete it, losing the soul-knowledge promotion.

Before retiring, run:

```bash
git merge-base --is-ancestor <harvest-sha> origin/main
```

If the harvest commit is not an ancestor of `origin/main`, cherry-pick the harvest commits onto a knowledge-only branch cut from `origin/main`, union-resolve soul log/index conflicts, run `validate:okf`, open a PR, and route it through a maintainer like any other main-bound change. During keybindings, both developers hit this; one PR carried both preservations.

Preserve the chain, not just the tip: a final harvest commit may semantically depend on earlier harvest commits on the same branch, such as a follow-up queue referencing a lesson rewritten by the parent harvest. Cherry-pick every not-on-main harvest commit in order:

```bash
git log origin/main..<branch> -- <soul-path>
```

Otherwise the maintainer's knowledge-consistency gate can return the PR.

Also hold retirement while the developer's harvester instance is still running on their tree; check `oas status` for `memory-harvest-*` before deleting the branch.
