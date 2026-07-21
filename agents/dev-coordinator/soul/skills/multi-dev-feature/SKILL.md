---
name: multi-dev-feature
description: Coordinator choreography for a multi-developer feature — feature-branch creation, per-developer branches, cross-developer dependency brokering, integration merges, validation, merged-state review, and PR delivery. Use when planning, running, or unblocking a feature that spans more than one developer.
---

# Multi-developer feature choreography

You (the coordinator) own the feature branch and the PR. Developers own only
their per-developer branches. All coordination is aweb mail; between events
you go idle — never sleep-poll.

## 1. Setup

```bash
git -C ./work fetch origin
git -C ./work push origin origin/main:refs/heads/feature/<name>
```

Write one task brief per developer. Each brief must state:
- the shared interface/contract (write it first — it is what makes parallel
  work possible);
- their branch: `<dev>/<name>` **cut from `feature/<name>`** (not main);
- deliver by pushing their branch and mailing you — they never open the PR
  and never merge into the feature branch;
- who the coordinator is (your instance alias) for questions/dependencies.

Spawn each developer with `oas spawn <dev> --task-file <brief>` (worktree
mode is their soul default). Sequence dependency-heavy parts first.

## 2. During development

- Track in STATE.md: developer, instance, branch, status, blockers.
- **Dependency requests**: when developer B needs developer A's unmerged
  code: confirm A's relevant commits are pushed; merge `origin/<A>/<name>`
  into `feature/<name>` (validate it builds); push; mail B to merge
  `origin/feature/<name>` into their branch. Never tell B to touch A's
  branch.
- Developers run their own post-commit reviewers; you don't re-review their
  in-flight commits.

## 3. Integration

When a developer mails "ready": integrate in a **dedicated integration
worktree** — your `./work` is the shared checkout and you must never switch
its branch:

```bash
git -C <repo> worktree add /tmp/integrate-<name> feature/<name>
git -C /tmp/integrate-<name> merge --no-ff origin/<dev>/<name>
```

Resolve trivial conflicts yourself; route non-trivial ones back to the
developer with the conflict context. After each merge, run the repo's full
gate (for this repo: `npm test`, `npm run check`, `npm run validate`,
`npm run pack:check`). Push the feature branch when green.

## 4. Merged-state review

After ALL developer branches are merged and the gate is green, launch a
fresh reviewer on the integrated diff:

```bash
oas spawn reviewer --work attached --work-dir <integration-worktree> \
  --purpose "<feature-short-sha>" \
  --task "Review the merged feature diff origin/main..feature/<name>. Report to <your-instance> per your operating loop."
```

Go idle; the verdict arrives by aweb mail. `NEEDS CHANGES` → route findings
to the owning developer(s), re-merge, re-gate, re-review.

## 5. Delivery

- `gh pr create` from `feature/<name>` (you own the PR). Summarize scope,
  developer branches merged, review verdict.
- Mail the maintainer (oas-expert) the PR number; relay review feedback to
  the right developer; re-request review after fixes.
- After merge: delete the feature and developer branches, remove any temp
  worktree (`git worktree remove`), confirm developers harvested and retire
  them, log the delivery.
