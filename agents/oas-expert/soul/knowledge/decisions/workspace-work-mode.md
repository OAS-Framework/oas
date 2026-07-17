---
type: Decision
title: Workspace work mode for cross-repo coordinators
status: accepted
description: A fourth work mode, workspace, points ./work at the team scope instead of a repo — for free agents (coordinators, dispatchers, architects) that read all member repos but never edit them; their soul lives in a committed home repo (e.g. a workspace's lfx-agents), and OKF harvest delivers their knowledge promotions as PRs to that repo instead of committing in the work tree.
tags: [work-modes, workspace, coordinator, okf, harvest, pr]
timestamp: 2026-07-17
---

Decided with the founder, 2026-07-17, motivated by LFX: a `lfx-agents/` repo
inside the `~/lfx` workspace holds souls whose job is cross-repo support —
none of the three existing modes fit (checkout/worktree bind to one repo's
tree; the coordinator's context is the workspace).

# Shape

`work: workspace` in soul.yaml (or `--work workspace`): `./work` symlinks to
the **team scope** (the `team:` block's declaring directory), falling back to
the closest non-laptop config scope; spawning fails with a pointed error when
neither resolves — the mode requires a declared boundary. No branch is
recorded (the workspace is not a git tree); retire never touches the tree.

The packaged `work-workspace` briefing carries the discipline
(instruction-only enforcement, consistent with the other modes — OAS does
not sandbox, harnesses do):
- read freely across member repos; never edit or commit inside them — route
  changes to the owning repo's agents (`oas status --team`, task layer,
  messaging) or the human;
- no git state operations in member repos;
- the one git exception is the soul's own home repo, and only via harvest.

Where the soul lives and where it works are decoupled: the soul stays
committed/versioned in its home repo while `repo:` keeps provenance; the
work symlink ignores it.

# OKF interaction — knowledge lands as PRs

The normal harvest attaches to the instance's work tree and commits there —
impossible (workspace tree is not a repo) and undesirable (member repos must
not receive soul commits). For `work: workspace` instances, `oas okf
harvest` (oas.okf v1.1.0) instead:

1. locates the soul's home repo (git root above the canonical soul dir;
   skips with a clear message when the soul is not repo-resident),
2. spawns the harvester in a **worktree** of that repo on branch
   `memory-harvest/<instance>`,
3. instructs it to promote notes, commit once, **push the branch and open a
   PR** (`gh pr create --fill`; falls back to reporting the compare URL),
   never merging — soul changes in shared agent repos get human review,
4. retire keeps the branch.

The okf injection tells workspace-mode instances explicitly: write notes,
commit nothing yourself, call the harvester — the PR flow is automatic.

# Rejected

- Permission-based enforcement of "read-only member repos": rejected — OAS
  is not a sandbox; the briefing is the contract, like every other mode's
  discipline.
- Pointing `repo:` at the workspace: rejected — `repo:` is provenance and
  resolveRepo demands a git repo; the boundary comes from config, not repo.
