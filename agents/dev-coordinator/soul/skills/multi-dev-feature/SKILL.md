---
name: multi-dev-feature
description: Coordinator choreography for a multi-developer feature — feature-branch creation, per-developer branches, cross-developer dependency brokering, integration merges, validation, merged-state review, and PR delivery. Use when planning, running, or unblocking a feature that spans more than one developer.
---

# Multi-developer feature choreography

You (the coordinator) own the feature branch and the PR. Developers own only
their per-developer branches. All coordination is aweb mail; between events
you go idle — never sleep-poll.

## 1. Setup

First prove this is actually multi-developer work: scan the relevant repo
surfaces, the soul roster, and likely owning code paths. If every changed
surface belongs to one developer soul, collapse to a single-developer feature
instead of inventing parallel choreography.

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

Spawn each developer with `oas spawn <dev> --task-file <brief>
--parent "$OAS_INSTANCE"` (worktree mode is their soul default) — lineage is
explicit, so pass your own instance as the parent or they land as top-level
operator roots. Sequence dependency-heavy parts first.

## 2. During development

- Track in STATE.md: developer, instance, branch, status, blockers.
- **Agent health**: discover attached cross-repository agents from the configured workspace boundary with `oas status --team --dir <workspace-team-root>`. They appear beneath their worktree owners, not necessarily beneath you. Treat aweb roster presence as addressability only; require explicit progress or exact-pane evidence before reporting an agent as executing, and escalate interactive prompts as blockers.
- **Dependency requests**: when developer B needs developer A's unmerged
  code: confirm A's relevant commits are pushed; merge `origin/<A>/<name>`
  into `feature/<name>` (validate it builds); push; mail B to merge
  `origin/feature/<name>` into their branch. Never tell B to touch A's
  branch.
- **Fast-loop aweb mail**: every coordination mail states the exact feature
  head, what is already merged, and exactly one next action. If crossed mail
  references stale state, reconcile against git and reply with current truth
  instead of re-litigating.
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
developer with the conflict context. In a fresh integration worktree, install
root dependencies before root gates (`npm install`) and install package-local
dependencies for package gates (for desktop work, run `npm install` inside
`packages/desktop`). After each merge, run the repo's full gate (for this
repo: `npm test`, `npm run check`, `npm run validate`, `npm run pack:check`).
Push the feature branch when green.

## 4. Merged-state review

Before each merged-state review, fetch origin and compare the feature against
current `origin/main`. If main advanced since the feature base, reconcile and
re-gate before spawning the reviewer or opening the PR; a stale-base green gate
tests the wrong product. Route behavioral merge conflicts in developer-owned
feature logic back to that developer with the conflict map; keep only
trivial/union conflicts yourself.

After ALL developer branches are merged and the gate is green, launch a
fresh reviewer on the integrated diff:

```bash
oas spawn reviewer --work attached --work-dir <integration-worktree> \
  --parent "$OAS_INSTANCE" \
  --purpose "<feature-short-sha>" \
  --task "Review the merged feature diff origin/main..feature/<name>. Report to <your-instance> per your operating loop."
```

(The integration worktree is yours, not an instance's `<home>/work`, so the
owner cannot be inferred — `--parent "$OAS_INSTANCE"` names you explicitly;
attached agents are always children of their owner.)

Go idle; the verdict arrives by aweb mail. `NEEDS CHANGES` → route findings
to the owning developer(s), re-merge, re-gate, re-review.

## 5. Delivery

- **Check for peer features first**: other coordinator instances may be
  running parallel features against the same main (`oas status --team` shows
  live coordinators; `git ls-remote origin 'refs/heads/feature/*'` shows their
  branches). This check is silent — do not mail peer coordinators to announce
  yourself or ask about their plans. Contact one only when there is an actual
  conflict: before or after opening your PR, your feature conflicts with (or
  is conflicted by) another coordinator's feature or PR. Then:
  1. Mail that coordinator directly (anchor on exact heads and the specific
     conflicting paths) and agree the merge order and who rebases/resolves.
  2. Whoever merges second updates their feature branch from main after the
     first PR lands, resolves, re-gates, and re-requests review.
  3. If you two cannot agree (competing designs, contested ownership or
     order), spawn an oas-expert as **parent of both coordinators** to
     arbitrate:

     ```bash
     oas spawn oas-expert --purpose "merge-conflict-<a>-vs-<b>" \
       --relation parent --relative-to "$OAS_INSTANCE" \
       --task "Arbitrate the merge conflict between feature/<a> (coordinator <you>) and feature/<b> (coordinator <peer>). You oversee both coordinators for this conflict: decide merge order and resolution ownership, and consult the human if you need product/direction input. Report your ruling to both coordinators by aweb mail."
     ```

     The relation flag re-points YOUR lineage; agree with the peer
     coordinator (or have the expert instruct them) that the expert oversees
     them for this conflict too — the expert's ruling binds both of you.
     Never resolve the collision by silently overwriting the other feature's
     changes.
- `gh pr create` from `feature/<name>` (you own the PR). Summarize scope,
  developer branches merged, review verdict.
- **Launch the framework expert (oas-expert) for the merge** — main only
  moves through its maintainer review, and every PR gets its **own fresh
  maintainer instance** (even if another oas-expert is live):

  ```bash
  oas spawn oas-expert --purpose "pr<n>" --relation parent --relative-to "$OAS_INSTANCE" \
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
- After merge: delete the feature branch and any temp worktree (`git worktree
  remove`). Before deleting developer branches or retiring developers, freeze
  each source note directory once harvesting starts and confirm every post-merge
  harvest commit is an ancestor of fetched `origin/main`. If not, preserve the
  complete not-on-main harvest chain on a knowledge-only PR. Verify the source
  `.md` count is zero before retirement, then retire the developer and log the
  delivery.

## Gotchas

- A task can arrive at the coordinator sounding multi-dev but map entirely to
  one soul after repo/soul ownership scouting. Do the ownership scan before
  spawning developers, and collapse to a single-developer path when only one
  soul owns the touched surfaces. See [Scope a coordinator feature to one
  developer when ownership scan
  collapses](../knowledge/lessons/scope-feature-before-spawning-developers.md).
- Before merged-state review and PR delivery, check whether `origin/main`
  advanced since the feature base. If it did, reconcile first; route behavioral
  conflicts in developer-owned feature logic back to that developer rather than
  resolving feature semantics in the coordinator worktree. See [Merged-state
  reviewers catch stale-base drift against moving
  main](../knowledge/lessons/stale-base-drift-merged-review.md).
- In a fast two-developer loop, crossed aweb mail can dominate coordination
  churn. Anchor every mail on exact commit heads, what is already merged, and a
  single next action; once PR-ready, declare a hard freeze where only
  blocker-class defects get commits. See [Crossed aweb mail dominates
  multi-dev integration churn — anchor every mail on exact
  heads](../knowledge/lessons/crossed-mail-coordination.md).
- If multiple parallel instances of the same soul harvest into separate
  branches, their soul knowledge files can conflict during integration. Union
  append-only `knowledge/log.md` conflicts and pure-addition index/link
  conflicts yourself, verify cross-links exist after the union, but route
  duplicate lessons, competing concept rewrites, and section-index judgment to
  an owner instance of that soul. See [Concurrent harvests of one soul: union
  pure additions, route editorial
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
- Post-merge developer harvests can strand on the developer's instance branch.
  Before `oas retire --delete-branch`, check whether every harvest commit is an
  ancestor of `origin/main`; if not, cherry-pick the whole harvest chain onto a
  knowledge-only PR and wait for any `memory-harvest-*` instance on that tree to
  finish. See [Post-merge developer harvests land on instance branches —
  preserve before retiring](../knowledge/lessons/post-merge-harvest-stranding.md).
- Fresh integration worktrees need dependency installs before gates: run root
  `npm install` before root scripts such as `npm run validate`, and run package
  installs such as `cd packages/desktop && npm install` before package-local
  tests, or missing imports can look like feature regressions. See [Integration
  worktrees need root and package npm installs before
  gates](../knowledge/lessons/integration-worktree-desktop-npm-install.md).
- If a merged-state review fix makes a feature reachable by adding a new
  user-facing surface (tab, sidebar, menu, stage), pause before merging and
  ask the human/maintainer whether that product surface is in scope; prefer
  satisfying reachability inside existing surfaces when possible. See
  [Merged-state review fixes can overreach scope — validate new user-facing
  surfaces with the human](../knowledge/lessons/review-fix-scope-overreach.md).
- Agent presence is not execution. Attached agents appear under their worktree
  owner in OAS discovery, cross-repository status requires the workspace team
  scope, and an aweb roster row can hide an interactive trust prompt. See
  [Agent discovery, addressability, and execution are distinct
  states](../knowledge/lessons/agent-discovery-addressability-and-execution-are-distinct.md).
- Do not write new notes after a harvester inventories a source directory. If
  attached harvest fails on conflicting relation flags, preserve the source and
  have the worktree owner launch the harvester after product-head review with no
  explicit parent/relation flags. Never retire until strict validation,
  knowledge-only delivery, and zero source notes are confirmed. See
  [Post-merge developer harvests land on instance branches — preserve before
  retiring](../knowledge/lessons/post-merge-harvest-stranding.md).
- Technical review does not replace a separately required human authorization
  for an irreversible tag or publication. Record the human provenance before
  execution, and require acknowledgement of a late HOLD rather than assuming a
  sent message stopped the terminal actor. See [Human approval remains a
  separate gate for irreversible
  releases](../knowledge/decisions/human-approval-for-irreversible-releases.md).
