---
type: Lesson
title: Post-merge developer harvests land on instance branches — preserve before retiring
description: A developer's final harvest can strand on an instance branch or fail in attached mode; preserve frozen notes, deliver a knowledge-only PR, and verify zero notes before retirement.
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

Once a harvester inventories a source `notes/` directory, freeze writes to that directory until the harvest finishes. Mid-run notes can escape the inventory or race validation. Resume note capture only after the harvester reports delivery and the source independently verifies that the source `.md` count is zero.

Attached mode adds two custody constraints:

- An attached harvester shares and commits on the owner's product worktree. Do not start one while an exact product head is frozen for review; finish the product disposition first, then deliver the soul-only delta separately.
- Attached lineage mandates the worktree owner as parent. If `oas okf harvest` fails because helper-supplied relation flags conflict with that parent, preserve the source instance and notes. After product review, have the worktree owner launch `memory-harvest` attached with no explicit relation or parent flags and name the complete source notes set and soul path in its task.

A failed helper never makes notes disposable. Keep the source home until every note has been promoted, merged, or dropped, the strict knowledge validator passes, the knowledge-only delta is delivered, and the source note count is zero.
