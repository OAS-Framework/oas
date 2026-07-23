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
- **Launch the framework expert (oas-expert) for the merge** — main only
  moves through its maintainer review, and every PR gets its **own fresh
  maintainer instance** (even if another oas-expert is live):

  ```bash
  oas spawn oas-expert --purpose "pr<n>" \
    --task "Maintainer review of PR #<n> (feature/<name>): run your pr-review gates. You own this PR to its terminal outcome — on RETURN stay alive and idle for my fixed-mail, re-review, repeat; on merge/close record the delivery in your stewardship knowledge and retire yourself. Report verdicts to <your-instance> by aweb mail."
  ```

  Go idle — the verdict/merge notice arrives by aweb mail. You never merge
  to main yourself.
- **The maintainer instance persists across RETURN rounds**: relay its
  findings to the right developer, collect the fixes onto the feature
  branch, then mail the SAME maintainer (reply on its thread) to re-review
  — never spawn a second maintainer for the same PR.
- **Reviewers are the opposite — one per commit, then gone**: a post-commit
  or merged-state reviewer mails its verdict and retires. Re-reviewing a
  fix means spawning a NEW reviewer on the new commit
  (`--purpose <new-short-sha>`); never wait on or mail a retired reviewer.
- After merge: delete the feature and developer branches, remove any temp
  worktree (`git worktree remove`), confirm developers harvested and retire
  them, log the delivery.

## Gotchas

- If multiple parallel instances of the same soul harvest into separate
  branches, their soul knowledge files can conflict during integration. Union
  append-only `knowledge/log.md` conflicts yourself, but route duplicate
  lessons, competing concept rewrites, and section-index judgment to an owner
  instance of that soul. See [Concurrent harvests of one soul need owner
  reconciliation for knowledge
  conflicts](../knowledge/lessons/concurrent-harvest-conflicts-one-soul.md).
- If a reviewer appears dead, check `aw mail inbox --show-all` before acting;
  awakening events can lag behind delivered verdict mail. If the session JSONL
  stops cleanly mid-turn and the tmux window is missing, treat it as an
  external kill: unblock the waiter by having it spawn a fresh one-shot
  reviewer on the same commit, then retire the dead instance. See [Reviewer
  deaths can come from tmux prefix-target
  kills](../knowledge/lessons/reviewer-deaths-tmux-prefix-targets.md).
- If review flags factual errors in a developer's `notes/` or knowledge content,
  have the developer fix the notes before running `oas okf harvest`; harvest
  promotes notes verbatim. See [Fix doc nits in notes before the harvest
  runs](../knowledge/lessons/fix-note-errors-before-harvest.md).
- A docs-only follow-up PR does not require keeping the authoring developer
  alive after the feature PR has merged and the developer's memory protocol is
  complete. Confirm the feature PR is merged, harvest reports no pending notes,
  local and remote branches are deleted, and the developer reports the task
  complete; then retire the developer and shepherd the docs PR yourself. See
  [Retire developers without holding on docs-only follow-up
  PRs](../knowledge/lessons/retire-dev-without-docs-pr.md).
